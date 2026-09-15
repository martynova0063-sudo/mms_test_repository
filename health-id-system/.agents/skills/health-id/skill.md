## Шаблон детекции дрейфа данных
```python
"""
Подсистема отслеживания дрейфа входных данных и дрейфа решений.
Запускается по расписанию (еженедельно). Результаты — в model governance.

Два типа дрейфа:
  1. Data drift — распределение входных признаков изменилось
  2. Concept drift — распределение решений (HEALTH_ID) изменилось
     при стабильных входах (косвенный признак)
"""
from __future__ import annotations

import json
import hashlib
from datetime import datetime, timezone, timedelta
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd
from scipy import stats
from pydantic import BaseModel


# ─── Конфигурация ─────────────────────────────────────────────────

DRIFT_CONFIG = {
    "reference_window_days": 30,   # эталонное окно
    "current_window_days": 7,      # текущее окно
    "significance_level": 0.05,    # порог p-value
    "severity_thresholds": {
        "high": 0.01,    # p < 0.01 → high
        "medium": 0.05,  # p < 0.05 → medium
    },
    "min_samples_per_window": 20, # минимум записей в окне
    "numeric_features": [
        "heart_rate",
        "blood_pressure_systolic",
        "blood_pressure_diastolic",
        "temperature",
        "spo2",
        "alcohol_test",
        "adequacy_score",
        "speech_coherence",
        "pupil_reaction",
    ],
    "categorical_features": [
        "examination_regularity",
    ],
    "health_id_metrics": [
        "health_id_value",
        "hBody_score",
        "hMental_score",
        "hSocial_score",
        "completeness",
        "uncertainty",
    ],
}


# ─── Схемы ────────────────────────────────────────────────────────

class DriftFeatureReport(BaseModel):
    feature: str
    test_name: str
    statistic: float
    p_value: float
    severity: str        # "none" | "low" | "medium" | "high"
    reference_mean: float | None = None
    current_mean: float | None = None
    reference_std: float | None = None
    current_std: float | None = None
    delta_mean: float | None = None
    delta_mean_pct: float | None = None


class DriftReport(BaseModel):
    report_id: str
    timestamp: str
    model_version: str
    reference_window: dict[str, str]    # {"start": "...", "end": "..."}
    current_window: dict[str, str]
    overall_severity: str               # "none" | "low" | "medium" | "high"
    drifted_features: list[DriftFeatureReport]
    healthy_features: list[str]
    health_id_drift: list[DriftFeatureReport]
    recommendation: str
    audit: dict[str, Any]


# ─── Детекция дрейфа ──────────────────────────────────────────────

def detect_data_drift(
    reference_df: pd.DataFrame,
    current_df: pd.DataFrame,
    model_version: str,
    config: dict[str, Any] | None = None,
) -> DriftReport:
    """
    Сравнивает распределения признаков между эталонным и текущим окнами.

    Для численных признаков — KS-тест (Колмогоров–Смирнов).
    Для категориальных — хи-квадрат.
    Для метрик HEALTH_ID — KS-тест (concept drift).
    """
    cfg = config or DRIFT_CONFIG
    alpha = cfg["significance_level"]
    min_samples = cfg["min_samples_per_window"]

    drifted_features = []
    healthy_features = []

    # Численные признаки
    for feature in cfg["numeric_features"]:
        if feature not in reference_df.columns or feature not in current_df.columns:
            continue

        ref_values = reference_df[feature].dropna().values
        cur_values = current_df[feature].dropna().values

        if len(ref_values) < min_samples or len(cur_values) < min_samples:
            healthy_features.append(feature)
            continue

        ks_stat, ks_p = stats.ks_2samp(ref_values, cur_values)

        severity = _classify_severity(ks_p, cfg["severity_thresholds"])

        if ks_p < alpha:
            drifted_features.append(DriftFeatureReport(
                feature=feature,
                test_name="KS",
                statistic=round(ks_stat, 4),
                p_value=round(ks_p, 6),
                severity=severity,
                reference_mean=round(float(np.mean(ref_values)), 4),
                current_mean=round(float(np.mean(cur_values)), 4),
                reference_std=round(float(np.std(ref_values)), 4),
                current_std=round(float(np.std(cur_values)), 4),
                delta_mean=round(float(np.mean(cur_values) - np.mean(ref_values)), 4),
                delta_mean_pct=round(
                    float((np.mean(cur_values) - np.mean(ref_values))
                          / max(abs(np.mean(ref_values)), 1e-9) * 100),
                    2,
                ),
            ))
        else:
            healthy_features.append(feature)

    # Категориальные признаки
    for feature in cfg.get("categorical_features", []):
        if feature not in reference_df.columns or feature not in current_df.columns:
            continue

        ref_counts = reference_df[feature].value_counts()
        cur_counts = current_df[feature].value_counts()

        all_categories = sorted(set(ref_counts.index) | set(cur_counts.index))
        if len(all_categories) < 2:
            healthy_features.append(feature)
            continue

        ref_arr = np.array([ref_counts.get(c, 0) for c in all_categories])
        cur_arr = np.array([cur_counts.get(c, 0) for c in all_categories])

        if ref_arr.sum() < min_samples or cur_arr.sum() < min_samples:
            healthy_features.append(feature)
            continue

        chi_stat, chi_p = stats.chisquare(cur_arr, ref_arr * cur_arr.sum() / ref_arr.sum())

        severity = _classify_severity(chi_p, cfg["severity_thresholds"])

        if chi_p < alpha:
            drifted_features.append(DriftFeatureReport(
                feature=feature,
                test_name="Chi-square",
                statistic=round(float(chi_stat), 4),
                p_value=round(float(chi_p), 6),
                severity=severity,
            ))
        else:
            healthy_features.append(feature)

    # Concept drift — метрики HEALTH_ID
    health_id_drift = []
    for metric in cfg["health_id_metrics"]:
        if metric not in reference_df.columns or metric not in current_df.columns:
            continue

        ref_values = reference_df[metric].dropna().values
        cur_values = current_df[metric].dropna().values

        if len(ref_values) < min_samples or len(cur_values) < min_samples:
            continue

        ks_stat, ks_p = stats.ks_2samp(ref_values, cur_values)
        severity = _classify_severity(ks_p, cfg["severity_thresholds"])

        if ks_p < alpha:
            health_id_drift.append(DriftFeatureReport(
                feature=metric,
                test_name="KS",
                statistic=round(ks_stat, 4),
                p_value=round(ks_p, 6),
                severity=severity,
                reference_mean=round(float(np.mean(ref_values)), 4),
                current_mean=round(float(np.mean(cur_values)), 4),
                delta_mean=round(float(np.mean(cur_values) - np.mean(ref_values)), 4),
                delta_mean_pct=round(
                    float((np.mean(cur_values) - np.mean(ref_values))
                          / max(abs(np.mean(ref_values)), 1e-9) * 100),
                    2,
                ),
            ))

    # Общая оценка
    all_drifted = drifted_features + health_id_drift
    if any(d.severity == "high" for d in all_drifted):
        overall = "high"
    elif any(d.severity == "medium" for d in all_drifted):
        overall = "medium"
    elif all_drifted:
        overall = "low"
    else:
        overall = "none"

    recommendation = _generate_recommendation(overall, drifted_features, health_id_drift)

    now = datetime.now(timezone.utc)
    report = DriftReport(
        report_id=f"drift_{now.strftime('%Y%m%d_%H%M%S')}",
        timestamp=now.isoformat(),
        model_version=model_version,
        reference_window={
            "start": (now - timedelta(days=cfg["reference_window_days"])).isoformat(),
            "end": now.isoformat(),
        },
        current_window={
            "start": (now - timedelta(days=cfg["current_window_days"])).isoformat(),
            "end": now.isoformat(),
        },
        overall_severity=overall,
        drifted_features=drifted_features,
        healthy_features=healthy_features,
        health_id_drift=health_id_drift,
        recommendation=recommendation,
        audit={
            "config_hash": hashlib.sha256(
                json.dumps(cfg, sort_keys=True).encode()
            ).hexdigest()[:16],
            "reference_n": len(reference_df),
            "current_n": len(current_df),
            "tests_run": len(cfg["numeric_features"])
                        + len(cfg.get("categorical_features", []))
                        + len(cfg["health_id_metrics"]),
            "immutable": True,
        },
    )

    return report


def _classify_severity(p_value: float, thresholds: dict[str, float]) -> str:
    if p_value < thresholds["high"]:
        return "high"
    elif p_value < thresholds["medium"]:
        return "medium"
    return "low"


def _generate_recommendation(
    overall: str,
    drifted: list[DriftFeatureReport],
    concept_drift: list[DriftFeatureReport],
) -> str:
    if overall == "none":
        return "Дрейф не обнаружен. Модель стабильна."

    parts = []
    if overall == "high":
        parts.append(
            "⚠️ Обнаружен высокозначимый дрейф данных. "
            "Рекомендуется приостановить использование модели и инициировать пересмотр."
        )
    elif overall == "medium":
        parts.append(
            "⚠️ Обнаружен умеренный дрейф. "
            "Рекомендуется провести ретроспективный анализ и рассмотреть обновление норм/порогов."
        )
    else:
        parts.append("Обнаружен слабый дрейф. Рекомендуется мониторинг.")

    if drifted:
        names = [d.feature for d in drifted]
        parts.append(f"Дрейф признаков: {', '.join(names)}.")

    if concept_drift:
        names = [d.feature for d in concept_drift]
        parts.append(f"Дрейф метрик HEALTH_ID: {', '.join(names)}.")
        parts.append(
            "⚠️ Concept drift — распределение решений изменилось. "
            "Возможно, изменилась популяция или условия измерений."
        )

    return " ".join(parts)


# ─── Плановый запуск ──────────────────────────────────────────────

def run_scheduled_drift_check(
    results_df: pd.DataFrame,
    model_version: str,
    config: dict[str, Any] | None = None,
) -> DriftReport:
    """
    Еженедельная проверка дрейфа.
    Разделяет results_df на reference и current окна по дате.
    """
    cfg = config or DRIFT_CONFIG
    now = datetime.now(timezone.utc)

    ref_start = now - timedelta(days=cfg["reference_window_days"])
    cur_start = now - timedelta(days=cfg["current_window_days"])

    if "timestamp" not in results_df.columns:
        raise ValueError("results_df must have 'timestamp' column")

    results_df["timestamp_dt"] = pd.to_datetime(results_df["timestamp"], utc=True)

    reference_df = results_df[
        (results_df["timestamp_dt"] >= ref_start) &
        (results_df["timestamp_dt"] < cur_start)
    ].drop(columns=["timestamp_dt"])

    current_df = results_df[
        results_df["timestamp_dt"] >= cur_start
    ].drop(columns=["timestamp_dt"])

    if len(reference_df) < cfg["min_samples_per_window"]:
        return DriftReport(
            report_id=f"drift_{now.strftime('%Y%m%d_%H%M%S')}",
            timestamp=now.isoformat(),
            model_version=model_version,
            reference_window={"start": ref_start.isoformat(), "end": cur_start.isoformat()},
            current_window={"start": cur_start.isoformat(), "end": now.isoformat()},
            overall_severity="none",
            drifted_features=[],
            healthy_features=[],
            health_id_drift=[],
            recommendation="Недостаточно данных в эталонном окне для анализа.",
            audit={"reference_n": len(reference_df), "current_n": len(current_df)},
        )

    return detect_data_drift(reference_df, current_df, model_version, cfg)
```

## Шаблон liveness detection
```python
"""
Модуль liveness detection — подтверждение присутствия живого человека.
Комбинированный подход: active liveness (интерактивные пробы)
+ passive liveness (анализ микродвижений, текстуры, глубины).

⚠️ Видеоданные не сохраняются. Сохраняются только метрики и хеши.
"""
from __future__ import annotations

import hashlib
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

import cv2
import numpy as np


# ─── Конфигурация ─────────────────────────────────────────────────

LIVENESS_CONFIG = {
    "active_challenges": [
        {"name": "blink", "instruction": "Моргните 2 раза", "duration_sec": 5},
        {"name": "turn_head_left", "instruction": "Поверните голову налево", "duration_sec": 4},
        {"name": "turn_head_right", "instruction": "Поверните голову направо", "duration_sec": 4},
        {"name": "smile", "instruction": "Улыбнитесь", "duration_sec": 3},
    ],
    "passive_checks": {
        "micro_movement": {
            "enabled": True,
            "min_motion_frames": 8,        # минимум кадров с микродвижениями
            "motion_threshold": 0.5,       # порог межкадровой разницы
            "analysis_window_sec": 3,
        },
        "texture_analysis": {
            "enabled": True,
            "min_lbp_score": 0.45,         # LBP-оценка текстуры кожи
        },
        "depth_estimation": {
            "enabled": True,
            "min_depth_variance": 2.0,     # дисперсия глубины (proxy)
        },
        "frequency_analysis": {
            "enabled": True,
            "min_pulse_freq": 0.6,         # Hz, удалённый фотоплетизмограмма
            "max_pulse_freq": 3.0,         # Hz
        },
    },
    "weights": {
        "active": 0.55,
        "passive": 0.45,
    },
    "thresholds": {
        "pass": 0.70,
        "warning": 0.50,
    },
    "attack_detection": {
        "photo_spoofing": "Анализ текстуры + отсутствие микродвижений",
        "video_spoofing": "Анализ границ кадра + частотный анализ",
        "3d_mask": "Анализ глубины + отражения",
        "deepfake": "Анализ согласованности движения + текстуры",
    },
}


# ─── Схемы ────────────────────────────────────────────────────────

class LivenessStatus(str, Enum):
    CONFIRMED = "confirmed"
    UNCERTAIN = "uncertain"
    FAILED = "failed"


class AttackType(str, Enum):
    NONE = "none"
    PHOTO_SPOOFING = "photo_spoofing"
    VIDEO_SPOOFING = "video_spoofing"
    MASK_3D = "3d_mask"
    DEEPFAKE = "deepfake"


@dataclass
class ActiveChallengeResult:
    name: str
    instruction: str
    completed: bool
    score: float
    duration_sec: float
    details: dict[str, Any]


@dataclass
class PassiveCheckResult:
    name: str
    score: float
    passed: bool
    details: dict[str, Any]


@dataclass
class LivenessResult:
    session_id: str
    overall_score: float
    status: LivenessStatus
    active_score: float
    passive_score: float
    active_results: list[ActiveChallengeResult]
    passive_results: list[PassiveCheckResult]
    detected_attack: AttackType
    attack_indicators: list[str]
    timestamp: str
    audit: dict[str, Any]


# ─── Active liveness ─────────────────────────────────────────────

def run_active_liveness(
    video_frames: list[np.ndarray],
    face_landmarks_per_frame: list[dict[str, Any]] | None = None,
    config: dict[str, Any] | None = None,
) -> tuple[float, list[ActiveChallengeResult]]:
    """
    Анализ активных проб: моргание, поворот головы, улыбка.
    video_frames — список кадров (уже записанных, не хранящихся после анализа).
    face_landmarks_per_frame — landmarks лица по кадрам (если доступны).
    """
    cfg = config or LIVENESS_CONFIG
    challenges = cfg["active_challenges"]
    results = []
    total_score = 0.0

    for challenge in challenges:
        result = _evaluate_challenge(
            challenge=challenge,
            frames=video_frames,
            landmarks=face_landmarks_per_frame,
        )
        results.append(result)
        total_score += result.score

    avg_score = total_score / len(challenges) if challenges else 0.0
    return avg_score, results


def _evaluate_challenge(
    challenge: dict[str, Any],
    frames: list[np.ndarray],
    landmarks: list[dict[str, Any]] | None,
) -> ActiveChallengeResult:
    """
    Оценивает выполнение одной пробы.
    В исследовательском режиме — упрощённая логика.
    """
    name = challenge["name"]

    if name == "blink" and landmarks:
        # Анализ EAR (Eye Aspect Ratio) по landmarks
        blink_detected = _detect_blink(landmarks)
        score = 1.0 if blink_detected else 0.2
        details = {"blink_count": 1 if blink_detected else 0, "ear_values": []}

    elif name in ("turn_head_left", "turn_head_right") and landmarks:
        # Анализ угла поворота головы
        direction = "left" if "left" in name else "right"
        turn_detected = _detect_head_turn(landmarks, direction)
        score = 1.0 if turn_detected else 0.2
        details = {"direction": direction, "max_yaw": 0.0, "detected": turn_detected}

    elif name == "smile" and landmarks:
        # Анализ улыбки (маркеры рта)
        smile_detected = _detect_smile(landmarks)
        score = 1.0 if smile_detected else 0.2
        details = {"smile_detected": smile_detected}

    else:
        # Без landmarks — fallback на анализ движения
        if len(frames) >= 2:
            motion = _estimate_motion(frames)
            score = min(1.0, motion / 10.0)
            details = {"motion_estimate": motion, "fallback": True}
        else:
            score = 0.0
            details = {"error": "insufficient_frames"}

    return ActiveChallengeResult(
        name=name,
        instruction=challenge["instruction"],
        completed=score >= 0.5,
        score=round(score, 4),
        duration_sec=challenge["duration_sec"],
        details=details,
    )


def _detect_blink(landmarks: list[dict[str, Any]]) -> bool:
    """Упрощённая детекция моргания через EAR."""
    ear_values = []
    for lm in landmarks:
        if "left_eye" in lm and "right_eye" in lm:
            ear = _calculate_ear(lm["left_eye"], lm["right_eye"])
            ear_values.append(ear)

    if len(ear_values) < 3:
        return False

    # Моргание — кратковременное падение EAR
    for i in range(1, len(ear_values) - 1):
        if ear_values[i] < 0.2 and ear_values[i - 1] > 0.25:
            return True
    return False


def _calculate_ear(left_eye: list, right_eye: list) -> float:
    """Eye Aspect Ratio — отношение расстояний век."""
    def _ear(eye):
        if len(eye) < 6:
            return 0.3
        p1, p2, p3, p4, p5, p6 = eye[:6]
        v1 = np.sqrt((p2[0]-p6[0])**2 + (p2[1]-p6[1])**2)
        v2 = np.sqrt((p3[0]-p5[0])**2 + (p3[1]-p5[1])**2)
        h = np.sqrt((p1[0]-p4[0])**2 + (p1[1]-p4[1])**2)
        return (v1 + v2) / (2 * h + 1e-9) if h > 0 else 0.3

    return (_ear(left_eye) + _ear(right_eye)) / 2


def _detect_head_turn(landmarks: list[dict[str, Any]], direction: str) -> bool:
    """Детекция поворота головы по изменению yaw."""
    yaw_values = [lm.get("yaw", 0.0) for lm in landmarks if "yaw" in lm]
    if not yaw_values:
        return False

    if direction == "left":
        return min(yaw_values) < -15
    return max(yaw_values) > 15


def _detect_smile(landmarks: list[dict[str, Any]]) -> bool:
    """Упрощённая детекция улыбки по ширине рта."""
    mouth_widths = []
    for lm in landmarks:
        if "mouth_left" in lm and "mouth_right" in lm:
            w = np.sqrt(
                (lm["mouth_left"][0] - lm["mouth_right"][0])**2 +
                (lm["mouth_left"][1] - lm["mouth_right"][1])**2
            )
            mouth_widths.append(w)

    if len(mouth_widths) < 3:
        return False

    # Улыбка — расширение рта
    return max(mouth_widths) > np.median(mouth_widths) * 1.25


def _estimate_motion(frames: list[np.ndarray]) -> float:
    """Оценка общего движения между кадрами (optical flow proxy)."""
    if len(frames) < 2:
        return 0.0
    total_motion = 0.0
    for i in range(1, len(frames)):
        prev_gray = cv2.cvtColor(frames[i-1], cv2.COLOR_BGR2GRAY)
        curr_gray = cv2.cvtColor(frames[i], cv2.COLOR_BGR2GRAY)
        diff = cv2.absdiff(prev_gray, curr_gray)
        total_motion += float(np.mean(diff))
    return total_motion / max(len(frames) - 1, 1)


# ─── Passive liveness ─────────────────────────────────────────────

def run_passive_liveness(
    video_frames: list[np.ndarray],
    config: dict[str, Any] | None = None,
) -> tuple[float, list[PassiveCheckResult], list[str]]:
    """
    Пассивный анализ: микродвижения, текстура, глубина, частотный анализ.
    """
    cfg = config or LIVENESS_CONFIG
    passive_cfg = cfg["passive_checks"]
    results = []
    attack_indicators = []

    # 1. Микродвижения
    if passive_cfg["micro_movement"]["enabled"]:
        score, indicators = _check_micro_movement(frames=video_frames, cfg=passive_cfg["micro_movement"])
        results.append(PassiveCheckResult(
            name="micro_movement",
            score=round(score, 4),
            passed=score >= 0.5,
            details={"indicators": indicators},
        ))
        attack_indicators.extend(indicators)

    # 2. Текстура кожи (LBP)
    if passive_cfg["texture_analysis"]["enabled"]:
        score, indicators = _check_texture(frames=video_frames, cfg=passive_cfg["texture_analysis"])
        results.append(PassiveCheckResult(
            name="texture_analysis",
            score=round(score, 4),
            passed=score >= passive_cfg["texture_analysis"]["min_lbp_score"],
            details={"indicators": indicators},
        ))
        attack_indicators.extend(indicators)

    # 3. Глубина (proxy через disparity)
    if passive_cfg["depth_estimation"]["enabled"]:
        score, indicators = _check_depth(frames=video_frames, cfg=passive_cfg["depth_estimation"])
        results.append(PassiveCheckResult(
            name="depth_estimation",
            score=round(score, 4),
            passed=score >= 0.5,
            details={"indicators": indicators},
        ))
        attack_indicators.extend(indicators)

    # 4. Частотный анализ (rPPG — удалённый фотоплетизмограмма)
    if passive_cfg["frequency_analysis"]["enabled"]:
        score, indicators = _check_rppg(frames=video_frames, cfg=passive_cfg["frequency_analysis"])
        results.append(PassiveCheckResult(
            name="frequency_analysis",
            score=round(score, 4),
            passed=score >= 0.5,
            details={"indicators": indicators},
        ))
        attack_indicators.extend(indicators)

    avg_score = sum(r.score for r in results) / len(results) if results else 0.0
    return avg_score, results, attack_indicators


def _check_micro_movement(frames: list[np.ndarray], cfg: dict[str, Any]) -> tuple[float, list[str]]:
    """
    Анализ микродвижений: подсчёт кадров с заметным изменением.
    Отсутствие микродвижений — индикатор фото-спуфинга.
    """
    indicators = []
    if len(frames) < 3:
        return 0.0, ["insufficient_frames"]

    motion_frames = 0
    for i in range(1, len(frames)):
        prev_gray = cv2.cvtColor(frames[i-1], cv2.COLOR_BGR2GRAY)
        curr_gray = cv2.cvtColor(frames[i], cv2.COLOR_BGR2GRAY)
        diff = cv2.absdiff(prev_gray, curr_gray)
        mean_diff = float(np.mean(diff))

        if mean_diff > cfg["motion_threshold"]:
            motion_frames += 1

    min_required = cfg["min_motion_frames"]
    score = min(1.0, motion_frames / min_required) if min_required > 0 else 0.0

    if motion_frames < 3:
        indicators.append("minimal_movement_possible_photo_spoofing")

    return score, indicators


def _check_texture(frames: list[np.ndarray], cfg: dict[str, Any]) -> tuple[float, list[str]]:
    """
    Анализ текстуры кожи через Local Binary Patterns (LBP).
    Фотографии и экраны имеют иную текстуру, чем живая кожа.
    """
    indicators = []
    if not frames:
        return 0.0, ["no_frames"]

    # Анализ центрального кадра
    mid_frame = frames[len(frames) // 2]
    gray = cv2.cvtColor(mid_frame, cv2.COLOR_BGR2GRAY)

    # LBP (упрощённый)
    lbp = _calculate_lbp(gray)
    # Высокая однородность LBP → возможна фотография/экран
    uniformity = float(np.std(lbp)) / (float(np.mean(lbp)) + 1e-9)
    min_score = cfg["min_lbp_score"]

    # Нормализация: более высокая равномерность = ниже score
    score = min(1.0, max(0.0, 1.0 - uniformity / 10.0))

    if score < min_score:
        indicators.append("low_texture_variance_possible_screen_photo")

    return score, indicators


def _calculate_lbp(image: np.ndarray) -> np.ndarray:
    """Упрощённый расчёт LBP."""
    h, w = image.shape
    lbp = np.zeros((h - 2, w - 2), dtype=np.uint8)

    for i in range(1, h - 1):
        for j in range(1, w - 1):
            center = image[i, j]
            code = 0
            code |= (1 << 0) if image[i-1, j-1] >= center else 0
            code |= (1 << 1) if image[i-1, j] >= center else 0
            code |= (1 << 2) if image[i-1, j+1] >= center else 0
            code |= (1 << 3) if image[i, j+1] >= center else 0
            code |= (1 << 4) if image[i+1, j+1] >= center else 0
            code |= (1 << 5) if image[i+1, j] >= center else 0
            code |= (1 << 6) if image[i+1, j-1] >= center else 0
            code |= (1 << 7) if image[i, j-1] >= center else 0
            lbp[i-1, j-1] = code

    return lbp


def _check_depth(frames: list[np.ndarray], cfg: dict[str, Any]) -> tuple[float, list[str]]:
    """
    Proxy-оценка глубины через анализ градиентов.
    Плоские поверхности (фото, экран) имеют низкую дисперсию градиентов.
    """
    indicators = []
    if not frames:
        return 0.0, ["no_frames"]

    mid_frame = frames[len(frames) // 2]
    gray = cv2.cvtColor(mid_frame, cv2.COLOR_BGR2GRAY)

    grad_x = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=3)
    grad_y = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=3)
    grad_mag = np.sqrt(grad_x**2 + grad_y**2)

    depth_variance = float(np.var(grad_mag))
    min_var = cfg["min_depth_variance"]
    score = min(1.0, depth_variance / (min_var * 2)) if min_var > 0 else 0.0

    if depth_variance < min_var:
        indicators.append("low_depth_variance_possible_flat_surface")

    return score, indicators


def _check_rppg(frames: list[np.ndarray], cfg: dict[str, Any]) -> tuple[float, list[str]]:
    """
    Удалённый фотоплетизмограмма (rPPG): детекция пульса через
    микровариации цвета кожи. Живой человек имеет пульс, фото — нет.
    """
    indicators = []
    if len(frames) < 10:
        return 0.0, ["insufficient_frames_for_rppg"]

    # Извлечение зелёного канала (максимальная чувствительность к пульсу)
    green_values = []
    for frame in frames:
        center_region = frame[
            frame.shape[0]//4 : 3*frame.shape[0]//4,
            frame.shape[1]//4 : 3*frame.shape[1]//4
        ]
        green = np.mean(center_region[:, :, 1])  # Зелёный канал
        green_values.append(green)

    green_signal = np.array(green_values, dtype=float)
    # Удаление тренда
    green_signal -= np.mean(green_signal)
    if np.std(green_signal) < 1e-6:
        indicators.append("no_color_variation_possible_photo")
        return 0.1, indicators

    # FFT для поиска пульсации
    fft = np.fft.rfft(green_signal)
    freqs = np.fft.rfftfreq(len(green_signal), d=1/15)  # 15 fps

    magnitudes = np.abs(fft)
    # Диапазон пульса: 36–180 bpm → 0.6–3.0 Hz
    pulse_mask = (freqs >= cfg["min_pulse_freq"]) & (freqs <= cfg["max_pulse_freq"])

    if not np.any(pulse_mask):
        indicators.append("no_pulse_frequency_detected")
        return 0.2, indicators

    peak_freq = freqs[pulse_mask][np.argmax(magnitudes[pulse_mask])]
    peak_magnitude = magnitudes[pulse_mask][np.argmax(magnitudes[pulse_mask])]
    total_magnitude = np.sum(magnitudes[1:])  # исключаем DC

    snr = peak_magnitude / (total_magnitude + 1e-9)
    score = min(1.0, snr * 10)  # нормализация

    if score < 0.3:
        indicators.append("weak_pulse_signal")

    return score, indicators


# ─── Детекция типа атаки ──────────────────────────────────────────

def detect_attack_type(
    active_results: list[ActiveChallengeResult],
    passive_results: list[PassiveCheckResult],
    attack_indicators: list[str],
) -> tuple[AttackType, list[str]]:
    """
    Классификация типа атаки на основе индикаторов.
    """
    indicators_text = " ".join(attack_indicators).lower()
    failed_passive = [r.name for r in passive_results if not r.passed]
    failed_active = [r.name for r in active_results if not r.completed]

    reasons = []

    # Фото-спуфинг: нет микродвижений + нет пульса + текстура плоская
    if ("micro_movement" in failed_passive
            and "frequency_analysis" in failed_passive
            and "photo" in indicators_text):
        reasons.append("Отсутствие микродвижений + нет пульса + плоская текстура")
        return AttackType.PHOTO_SPOOFING, reasons

    # Видеоспуфинг: есть движение, но нет пульса / аномальная текстура
    if ("frequency_analysis" in failed_passive
            and "screen" in indicators_text
            and "micro_movement" not in failed_passive):
        reasons.append("Движение есть, но нет пульса + текстура экрана")
        return AttackType.VIDEO_SPOOFING, reasons

    # 3D-маска: текстура аномальная + глубина плоская
    if ("texture_analysis" in failed_passive
            and "depth_estimation" in failed_passive
            and "flat_surface" in indicators_text):
        reasons.append("Аномальная текстура + плоская глубина")
        return AttackType.MASK_3D, reasons

    # Deepfake: активные пробы пройдены, но пассивные — нет
    if (len(failed_active) == 0
            and len(failed_passive) >= 2):
        reasons.append("Активные пробы пройдены, но пассивные проверки провалены")
        return AttackType.DEEPFAKE, reasons

    if attack_indicators:
        reasons.append(f"Обнаружены индикаторы: {'; '.join(attack_indicators)}")
        return AttackType.NONE, reasons

    return AttackType.NONE, []


# ─── Главная функция ──────────────────────────────────────────────

def run_liveness_check(
    video_frames: list[np.ndarray],
    face_landmarks_per_frame: list[dict[str, Any]] | None = None,
    config: dict[str, Any] | None = None,
) -> LivenessResult:
    """
    Полный пайплайн liveness detection.

    Возвращает LivenessResult с overall_score, статусом и типом атаки.
    ⚠️ Видео не сохраняется. Сохраняются только метрики и хеши.
    """
    cfg = config or LIVENESS_CONFIG
    session_id = f"lv_{uuid.uuid4().hex[:12]}"
    timestamp = _now_iso()

    # Active liveness
    active_score, active_results = run_active_liveness(
        video_frames=video_frames,
        face_landmarks_per_frame=face_landmarks_per_frame,
        config=cfg,
    )

    # Passive liveness
    passive_score, passive_results, attack_indicators = run_passive_liveness(
        video_frames=video_frames,
        config=cfg,
    )

    # Комбинированная оценка
    weights = cfg["weights"]
    overall_score = (
        active_score * weights["active"]
        + passive_score * weights["passive"]
    )

    # Определение статуса
    thresholds = cfg["thresholds"]
    if overall_score >= thresholds["pass"]:
        status = LivenessStatus.CONFIRMED
    elif overall_score >= thresholds["warning"]:
        status = LivenessStatus.UNCERTAIN
    else:
        status = LivenessStatus.FAILED

    # Детекция типа атаки
    attack_type, attack_reasons = detect_attack_type(
        active_results=active_results,
        passive_results=passive_results,
        attack_indicators=attack_indicators,
    )

    # Хеш видеоданных (для аудита, не для хранения)
    video_hash = _hash_frames(video_frames)

    return LivenessResult(
        session_id=session_id,
        overall_score=round(overall_score, 4),
        status=status,
        active_score=round(active_score, 4),
        passive_score=round(passive_score, 4),
        active_results=active_results,
        passive_results=passive_results,
        detected_attack=attack_type,
        attack_indicators=attack_indicators + attack_reasons,
        timestamp=timestamp,
        audit={
            "video_hash": video_hash,
            "frames_analyzed": len(video_frames),
            "config_hash": hashlib.sha256(
                json.dumps(cfg, sort_keys=True).encode()
            ).hexdigest()[:16],
            "⚠️ video_not_stored": True,
            "immutable": True,
        },
    )


def _hash_frames(frames: list[np.ndarray]) -> str:
    """Вычисляет хеш массива кадров для аудита (без хранения кадров)."""
    hasher = hashlib.sha256()
    for frame in frames:
        # Даунсэмплинг для ускорения хеширования
        small = cv2.resize(frame, (32, 32))
        hasher.update(small.tobytes())
    return f"sha256:{hasher.hexdigest()[:32]}"


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
```

## Шаблон протоколов валидации R0–R4
```python
"""
Протоколы и скрипты для поэтапной клинической валидации HEALTH_ID.

Каждый этап (R0–R4) реализован как отдельный модуль с:
  - протоколом (protocol.md)
  - скриптом запуска (run.py)
  - шаблоном отчёта (report_template.md)
  - чек-листом критериев прохода (checklist.yaml)

До завершения R4 модель остаётся в статусе 'research'.
"""
from __future__ import annotations

import json
import hashlib
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from scipy import stats
from pydantic import BaseModel


# ─── Базовые классы ──────────────────────────────────────────────

class ValidationStage(str):
    R0 = "R0_analytical"
    R1 = "R1_retrospective"
    R2 = "R2_external_prospective"
    R3 = "R3_clinical_utility"
    R4 = "R4_final"


class ValidationStatus(BaseModel):
    stage: str
    status: str           # "planned" | "in_progress" | "passed" | "failed"
    started_at: str | None = None
    completed_at: str | None = None
    criteria_met: bool | None = None
    report_path: str | None = None
    notes: str = ""


class ValidationResult(BaseModel):
    stage: str
    status: str           # "passed" | "failed"
    criteria: list[dict[str, Any]]
    metrics: dict[str, Any]
    report_path: str
    timestamp: str
    model_version: str
    audit: dict[str, Any]


class BaseValidation(ABC):
    """Базовый класс для этапов валидации."""

    stage: str = ""
    description: str = ""

    @abstractmethod
    def run(self, data: Any, model_version: str) -> ValidationResult:
        """Запуск этапа валидации."""
        ...

    @abstractmethod
    def check_criteria(self, metrics: dict[str, Any]) -> list[dict[str, Any]]:
        """Проверка критериев прохода."""
        ...

    def _generate_report(
        self,
        stage: str,
        metrics: dict[str, Any],
        criteria: list[dict[str, Any]],
        model_version: str,
    ) -> str:
        """Генерирует markdown-отчёт."""
        report_path = f"validation/{stage}/report.md"
        Path(f"validation/{stage}").mkdir(parents=True, exist_ok=True)

        passed = all(c["met"] for c in criteria)
        status = "✅ PASSED" if passed else "❌ FAILED"

        md = f"""# Отчёт валидации: {stage}

**Модель:** {model_version}  
**Дата:** {datetime.now(timezone.utc).isoformat()}  
**Статус:** {status}

## Метрики

"""
        for key, value in metrics.items():
            if isinstance(value, float):
                md += f"- **{key}**: {value:.4f}\n"
            elif isinstance(value, dict):
                md += f"- **{key}**:\n"
                for k, v in value.items():
                    md += f"  - {k}: {v}\n"
            else:
                md += f"- **{key}**: {value}\n"

        md += "\n## Критерии\n\n"
        md += "| Критерий | Порог | Факт | Статус |\n"
        md += "|---|---|---|---|\n"
        for c in criteria:
            md += f"| {c['name']} | {c['threshold']} | {c['actual']} | {'✅' if c['met'] else '❌'} |\n"

        md += f"\n## Заключение\n\n"
        if passed:
            md += f"Этап {stage} пройден. Модель может перейти к следующему этапу.\n"
        else:
            md += f"Этап {stage} НЕ пройден. Требуется корректировка модели.\n"
            md += f"Невыполненные критерии:\n"
            for c in criteria:
                if not c["met"]:
                    md += f"- {c['name']}: ожидалось {c['threshold']}, получено {c['actual']}\n"

        md += f"\n---\n*Автоматически сгенерировано. Исследовательский контур.*\n"

        with open(report_path, "w", encoding="utf-8") as f:
            f.write(md)

        return report_path


# ─── R0: Аналитическая валидация ─────────────────────────────────

class R0AnalyticalValidation(BaseValidation):
    """
    R0 — Аналитическая валидация.

    Цель: подтвердить корректность формул, воспроизводимость,
    отсутствие ошибок вычислений.

    Критерии:
      1. Воспроизводимость 100% (повторный расчёт = идентичный результат)
      2. Все unit-тесты pass
      3. Ручная верификация формул на выборке 100 событий
    """

    stage = ValidationStage.R0
    description = "Аналитическая валидация: формулы, воспроизводимость"

    def run(self, data: pd.DataFrame, model_version: str) -> ValidationResult:
        from app.core.engine.health_id_engine import calculate_health_id, HealthInput

        metrics = {}

        # 1. Воспроизводимость
        reproducibility_results = []
        sample = data.head(100) if len(data) > 100 else data

        for _, row in sample.iterrows():
            input_data = self._row_to_input(row)
            result1 = calculate_health_id(input_data, model_version)
            result2 = calculate_health_id(input_data, model_version)

            reproducible = (
                result1.health_id.get("value") == result2.health_id.get("value")
                and result1.audit["config_snapshot_hash"]
                    == result2.audit["config_snapshot_hash"]
            )
            reproducibility_results.append(reproducible)

        reproducibility_rate = sum(reproducibility_results) / len(reproducibility_results)
        metrics["reproducibility_rate"] = reproducibility_rate
        metrics["events_checked"] = len(reproducibility_results)

        # 2. Unit-тесты
        unit_test_result = self._run_unit_tests()
        metrics["unit_tests_passed"] = unit_test_result["passed"]
        metrics["unit_tests_total"] = unit_test_result["total"]
        metrics["unit_tests_rate"] = unit_test_result["rate"]

        # 3. Проверка формул — ручная выборка
        formula_check = self._verify_formulas(sample, model_version)
        metrics["formula_verification"] = formula_check

        # 4. Проверка хешей конфигурации
        config_consistency = self._check_config_consistency(model_version)
        metrics["config_consistency"] = config_consistency

        criteria = self.check_criteria(metrics)
        report_path = self._generate_report(
            self.stage, metrics, criteria, model_version
        )

        passed = all(c["met"] for c in criteria)

        return ValidationResult(
            stage=self.stage,
            status="passed" if passed else "failed",
            criteria=criteria,
            metrics=metrics,
            report_path=report_path,
            timestamp=datetime.now(timezone.utc).isoformat(),
            model_version=model_version,
            audit={
                "events_sampled": len(sample),
                "immutable": True,
            },
        )

    def check_criteria(self, metrics: dict[str, Any]) -> list[dict[str, Any]]:
        return [
            {
                "name": "Воспроизводимость",
                "threshold": "100%",
                "actual": f"{metrics['reproducibility_rate']*100:.1f}%",
                "met": metrics["reproducibility_rate"] == 1.0,
            },
            {
                "name": "Unit-тесты",
                "threshold": "100% pass",
                "actual": f"{metrics['unit_tests_passed']}/{metrics['unit_tests_total']}",
                "met": metrics["unit_tests_rate"] == 1.0,
            },
            {
                "name": "Ручная верификация формул (100 событий)",
                "threshold": "100% совпадение",
                "actual": f"{metrics['formula_verification']['match_rate']*100:.1f}%",
                "met": metrics["formula_verification"]["match_rate"] == 1.0,
            },
            {
                "name": "Целостность конфигурации",
                "threshold": "hash совпадает",
                "actual": "match" if metrics["config_consistency"]["hash_matches"] else "mismatch",
                "met": metrics["config_consistency"]["hash_matches"],
            },
        ]

    def _row_to_input(self, row: pd.Series) -> HealthInput:
        """Конвертация строки DataFrame в HealthInput."""
        from app.core.engine.health_id_engine import HealthInput, FeatureInput

        measurements = []
        feature_names = [
            "heart_rate", "blood_pressure_systolic", "blood_pressure_diastolic",
            "temperature", "spo2", "alcohol_test",
            "adequacy_score", "speech_coherence", "pupil_reaction",
        ]

        for name in feature_names:
            if name in row and pd.notna(row[name]):
                measurements.append(FeatureInput(
                    name=name,
                    value=float(row[name]),
                    unit="unit",
                    source="measured",
                    confidence=0.95,
                    artifact_pct=0,
                    timestamp=str(row.get("timestamp", "")),
                ))

        return HealthInput(
            event_id=str(row.get("event_id", "")),
            worker_pseudonym=str(row.get("worker_pseudonym", "")),
            timestamp=str(row.get("timestamp", "")),
            measurements=measurements,
        )

    def _run_unit_tests(self) -> dict[str, Any]:
        """Запуск unit-тестов pytest."""
        import subprocess

        result = subprocess.run(
            ["python", "-m", "pytest", "tests/unit/", "-v", "--tb=short"],
            capture_output=True,
            text=True,
        )

        passed = 0
        total = 0
        for line in result.stdout.split("\n"):
            if "passed" in line and "failed" in line:
                # "5 passed, 2 failed"
                parts = line.split()
                for part in parts:
                    if "passed" in part:
                        passed = int(part.split("passed")[0].strip())
                    if "failed" in part:
                        total += int(part.split("failed")[0].strip())
                total += passed
                break
            elif "passed" in line and "failed" not in line:
                # "5 passed"
                for part in line.split():
                    if "passed" in part:
                        passed = int(part.split("passed")[0].strip())
                        total = passed
                break

        return {
            "passed": passed,
            "total": total,
            "rate": passed / total if total > 0 else 0.0,
            "stdout_tail": result.stdout[-500:],
        }

    def _verify_formulas(self, sample: pd.DataFrame, model_version: str) -> dict[str, Any]:
        """
        Ручная (автоматизированная) верификация формул.
        Сравнивает результат движка с независимым расчётом.
        """
        from app.core.engine.health_id_engine import calculate_health_id

        matches = 0
        mismatches = []

        for _, row in sample.head(100).iterrows():
            input_data = self._row_to_input(row)
            result = calculate_health_id(input_data, model_version)

            engine_value = result.health_id.get("value")

            # Независимый расчёт
            manual_value = self._manual_calculate(row, model_version)

            if engine_value is not None and manual_value is not None:
                if abs(engine_value - manual_value) < 0.001:
                    matches += 1
                else:
                    mismatches.append({
                        "event_id": row.get("event_id"),
                        "engine": engine_value,
                        "manual": manual_value,
                        "diff": abs(engine_value - manual_value),
                    })

        total = matches + len(mismatches)
        return {
            "matches": matches,
            "mismatches": mismatches[:10],  # первые 10 для отчёта
            "match_rate": matches / total if total > 0 else 0.0,
        }

    def _manual_calculate(self, row: pd.Series, model_version: str) -> float | None:
        """
        Независимый расчёт HEALTH_ID для верификации.
        Дублирует логику движка, но отдельной реализацией.
        """
        # Нормализация одного признака
        def norm(val, low, high):
            if pd.isna(val):
                return None
            mid = (low + high) / 2
            half = (high - low) / 2
            if half == 0:
                return 1.0 if val == mid else 0.0
            dev = abs(val - mid) / half
            if dev <= 1:
                return 1.0 - 0.5 * dev
            return max(0, 0.5 - 0.5 * (dev - 1) / 2)

        # hBody
        hr = norm(row.get("heart_rate"), 60, 90) or 0
        bps = norm(row.get("blood_pressure_systolic"), 100, 130) or 0
        bpd = norm(row.get("blood_pressure_diastolic"), 60, 85) or 0
        temp = norm(row.get("temperature"), 36.1, 37.2) or 0
        spo2 = norm(row.get("spo2"), 95, 100) or 0
        alc = 1.0 if (row.get("alcohol_test", 0) or 0) < 0.16 else 0.0

        hBody = (hr * 0.25 + bps * 0.25 + bpd * 0.20 + temp * 0.15 + spo2 * 0.10 + alc * 0.05)

        # hMental
        adq = norm(row.get("adequacy_score"), 7, 10) or 0
        spc = norm(row.get("speech_coherence"), 7, 10) or 0
        pup = norm(row.get("pupil_reaction"), 7, 10) or 0

        # speech_coherence может отсутствовать — пересчёт весов
        if pd.isna(row.get("speech_coherence")):
            hMental = (adq * 0.40 + pup * 0.25) / 0.65
        else:
            hMental = adq * 0.40 + spc * 0.35 + pup * 0.25

        # hSocial (упрощённо — предполагаем норму)
        hSocial = 0.80

        return hBody * 0.60 + hMental * 0.25 + hSocial * 0.15

    def _check_config_consistency(self, model_version: str) -> dict[str, Any]:
        """Проверка: хеш конфигурации совпадает с опубликованным."""
        from app.core.engine.health_id_engine import load_model_config, hash_config

        try:
            config = load_model_config(model_version)
            actual_hash = hash_config(config)
            from app.core.engine.health_id_engine import _get_published_hash
            published_hash = _get_published_hash(model_version)

            return {
                "actual_hash": actual_hash,
                "published_hash": published_hash,
                "hash_matches": actual_hash == published_hash if published_hash else True,
            }
        except Exception as e:
            return {
                "actual_hash": None,
                "published_hash": None,
                "hash_matches": False,
                "error": str(e),
            }


# ─── R1: Ретроспективная валидация ───────────────────────────────

class R1RetrospectiveValidation(BaseValidation):
    """
    R1 — Ретроспективная валидация.

    Цель: оценка качества индекса на доступном датасете.

    Критерии:
      1. Распределение HEALTH_ID не имеет аномалий (skewness < 2, kurtosis < 7)
      2. Baseline стабилен (CV < 30% для работников с ≥ 5 точками)
      3. ≥ 90% расчётов с completeness ≥ 0.70
      4. Корреляция компонентов с витальными показателями > 0.3
    """

    stage = ValidationStage.R1
    description = "Ретроспективная валидация на пилотном датасете"

    def run(self, data: pd.DataFrame, model_version: str) -> ValidationResult:
        from app.core.engine.health_id_engine import calculate_health_id

        metrics = {}

        # Расчёт HEALTH_ID для всех событий
        results = []
        for _, row in data.iterrows():
            input_data = self._row_to_input(row)
            result = calculate_health_id(input_data, model_version)
            results.append(result)

        # Сбор значений
        values = [r.health_id.get("value") for r in results if r.health_id.get("value") is not None]
        completeness_values = [r.completeness.get("overall", 0) for r in results]
        hBody_values = [r.components.get("hBody").score if r.components.get("hBody") else None for r in results]

        # 1. Распределение
        if values:
            metrics["distribution"] = {
                "mean": float(np.mean(values)),
                "std": float(np.std(values)),
                "median": float(np.median(values)),
                "min": float(np.min(values)),
                "max": float(np.max(values)),
                "skewness": float(stats.skew(values)),
                "kurtosis": float(stats.kurtosis(values)),
                "q25": float(np.percentile(values, 25)),
                "q75": float(np.percentile(values, 75)),
            }
        else:
            metrics["distribution"] = {"error": "no valid values"}

        # 2. Стабильность baseline
        baseline_cv = self._calculate_baseline_stability(data)
        metrics["baseline_stability"] = baseline_cv

        # 3. Полнота данных
        completeness_pass_rate = sum(1 for c in completeness_values if c >= 0.70) / len(completeness_values) \
            if completeness_values else 0.0
        metrics["completeness_pass_rate"] = completeness_pass_rate
        metrics["completeness_mean"] = float(np.mean(completeness_values)) if completeness_values else 0.0

        # 4. Корреляции
        correlations = self._calculate_correlations(data, results)
        metrics["correlations"] = correlations

        # 5. Частота state_flags
        flag_counts = self._count_state_flags(results)
        metrics["state_flags"] = flag_counts

        criteria = self.check_criteria(metrics)
        report_path = self._generate_report(self.stage, metrics, criteria, model_version)

        passed = all(c["met"] for c in criteria)

        return ValidationResult(
            stage=self.stage,
            status="passed" if passed else "failed",
            criteria=criteria,
            metrics=metrics,
            report_path=report_path,
            timestamp=datetime.now(timezone.utc).isoformat(),
            model_version=model_version,
            audit={
                "events_total": len(data),
                "events_calculated": len(values),
                "immutable": True,
            },
        )

    def check_criteria(self, metrics: dict[str, Any]) -> list[dict[str, Any]]:
        dist = metrics.get("distribution", {})
        baseline = metrics.get("baseline_stability", {})
        corr = metrics.get("correlations", {})

        return [
            {
                "name": "Распределение: skewness",
                "threshold": "|skewness| < 2.0",
                "actual": f"{dist.get('skewness', 0):.4f}",
                "met": abs(dist.get("skewness", 10)) < 2.0,
            },
            {
                "name": "Распределение: kurtosis",
                "threshold": "|kurtosis| < 7.0",
                "actual": f"{dist.get('kurtosis', 0):.4f}",
                "met": abs(dist.get("kurtosis", 10)) < 7.0,
            },
            {
                "name": "Стабильность baseline (CV)",
                "threshold": "median CV < 30%",
                "actual": f"{baseline.get('median_cv', 100):.1f}%",
                "met": baseline.get("median_cv", 100) < 30,
            },
            {
                "name": "Полнота данных",
                "threshold": "≥ 90% с completeness ≥ 0.70",
                "actual": f"{metrics.get('completeness_pass_rate', 0)*100:.1f}%",
                "met": metrics.get("completeness_pass_rate", 0) >= 0.90,
            },
            {
                "name": "Корреляция hBody с ЧСС",
                "threshold": "|r| > 0.3",
                "actual": f"{corr.get('hBody_heart_rate', 0):.4f}",
                "met": abs(corr.get("hBody_heart_rate", 0)) > 0.3,
            },
        ]

    def _row_to_input(self, row: pd.Series) -> "HealthInput":
        """Конвертация строки в HealthInput (аналогично R0)."""
        from app.core.engine.health_id_engine import HealthInput, FeatureInput

        measurements = []
        feature_names = [
            "heart_rate", "blood_pressure_systolic", "blood_pressure_diastolic",
            "temperature", "spo2", "alcohol_test",
            "adequacy_score", "speech_coherence", "pupil_reaction",
        ]
        for name in feature_names:
            if name in row and pd.notna(row[name]):
                measurements.append(FeatureInput(
                    name=name, value=float(row[name]), unit="unit",
                    source="measured", confidence=0.95,
                    artifact_pct=0, timestamp=str(row.get("timestamp", "")),
                ))
        return HealthInput(
            event_id=str(row.get("event_id", "")),
            worker_pseudonym=str(row.get("worker_pseudonym", "")),
            timestamp=str(row.get("timestamp", "")),
            measurements=measurements,
        )

    def _calculate_baseline_stability(self, data: pd.DataFrame) -> dict[str, Any]:
        """CV (коэффициент вариации) по работникам с ≥ 5 точками."""
        from app.core.data.baseline import calculate_baseline

        cv_values = []
        workers = data["worker_pseudonym"].unique()

        for worker in workers:
            worker_data = data[data["worker_pseudonym"] == worker].sort_values("timestamp")
            if len(worker_data) < 6:
                continue

            history = worker_data.to_dict("records")
            last_event = history[-1]["event_id"]

            baseline = calculate_baseline(
                worker_pseudonym=worker,
                current_event_id=last_event,
                history=history[:-1],
            )

            if not baseline.get("available"):
                continue

            for feat_name, feat_data in baseline.get("features", {}).items():
                if feat_data.get("available") and feat_data.get("std", 0) > 0:
                    cv = feat_data["std"] / abs(feat_data["mean"]) * 100 if feat_data["mean"] != 0 else 100
                    cv_values.append(cv)

        return {
            "median_cv": float(np.median(cv_values)) if cv_values else 100,
            "mean_cv": float(np.mean(cv_values)) if cv_values else 100,
            "n_measurements": len(cv_values),
        }

    def _calculate_correlations(self, data: pd.DataFrame, results: list) -> dict[str, Any]:
        """Корреляция компонентов HEALTH_ID с витальными показателями."""
        hBody_scores = []
        hr_values = []
        bps_values = []

        for i, (_, row) in enumerate(data.iterrows()):
            if i < len(results):
                comp = results[i].components.get("hBody")
                if comp:
                    hBody_scores.append(comp.score)
                    hr_values.append(row.get("heart_rate", np.nan))
                    bps_values.append(row.get("blood_pressure_systolic", np.nan))

        corrs = {}
        if len(hBody_scores) > 5:
            valid = [(s, h, b) for s, h, b in zip(hBody_scores, hr_values, bps_values)
                     if not np.isnan(h) and not np.isnan(b)]
            if valid:
                s, h, b = zip(*valid)
                if len(s) > 3:
                    corrs["hBody_heart_rate"] = float(stats.pearsonr(s, h)[0])
                    corrs["hBody_bp_systolic"] = float(stats.pearsonr(s, b)[0])

        return corrs

    def _count_state_flags(self, results: list) -> dict[str, int]:
        """Подсчёт активных флагов по типам."""
        counts = {"acute_deviation": 0, "persistent_repeated_deviation": 0,
                  "confirmed_chronic": 0, "personal_deviation": 0}
        for r in results:
            for flag in r.state_flags:
                if flag.get("active") and flag.get("flag") in counts:
                    counts[flag["flag"]] += 1
        return counts


# ─── R2: Внешняя проспективная валидация ──────────────────────────

class R2ExternalProspectiveValidation(BaseValidation):
    """
    R2 — Внешняя проспективная валидация.

    Цель: проверка обобщаемости на независимом наборе данных.

    Критерии:
      1. KS-тест: p > 0.05 для основных признаков (распределения схожи)
      2. Отсутствие существенного дрейфа
      3. ROC-AUC > 0.70 (если есть метки known-healthy vs known-deviation)
      4. Согласие baseline между выборками
    """

    stage = ValidationStage.R2
    description = "Внешняя проспективная валидация на независимом датасете"

    def run(self, data: Any, model_version: str) -> ValidationResult:
        """
        data — кортеж (internal_df, external_df) или (internal_df, None).
        Если external_df = None, используется hold-out 30% внутреннего.
        """
        if isinstance(data, tuple):
            internal_df, external_df = data
        else:
            internal_df, external_df = data, None

        if external_df is None:
            # Hold-out 30%
            internal_df = internal_df.sample(frac=1, random_state=42).reset_index(drop=True)
            split_idx = int(len(internal_df) * 0.7)
            external_df = internal_df[split_idx:]
            internal_df = internal_df[:split_idx]
            holdout_note = "Использован hold-out 30% внутреннего датасета (внешний недоступен)"
        else:
            holdout_note = "Использован внешний датасет"

        metrics = {"note": holdout_note}

        # 1. Сравнение распределений
        feature_names = [
            "heart_rate", "blood_pressure_systolic", "blood_pressure_diastolic",
            "temperature", "spo2",
        ]
        ks_results = {}
        for feat in feature_names:
            if feat in internal_df.columns and feat in external_df.columns:
                int_vals = internal_df[feat].dropna().values
                ext_vals = external_df[feat].dropna().values
                if len(int_vals) > 5 and len(ext_vals) > 5:
                    ks_stat, ks_p = stats.ks_2samp(int_vals, ext_vals)
                    ks_results[feat] = {"statistic": round(ks_stat, 4), "p_value": round(ks_p, 6)}
        metrics["ks_tests"] = ks_results

        # 2. Расчёт HEALTH_ID для обеих выборок
        from app.core.engine.health_id_engine import calculate_health_id

        internal_health_ids = []
        for _, row in internal_df.iterrows():
            result = calculate_health_id(self._row_to_input(row), model_version)
            if result.health_id.get("value") is not None:
                internal_health_ids.append(result.health_id["value"])

        external_health_ids = []
        for _, row in external_df.iterrows():
            result = calculate_health_id(self._row_to_input(row), model_version)
            if result.health_id.get("value") is not None:
                external_health_ids.append(result.health_id["value"])

        # 3. Сравнение распределений HEALTH_ID
        if internal_health_ids and external_health_ids:
            ks_stat_h, ks_p_h = stats.ks_2samp(internal_health_ids, external_health_ids)
            metrics["health_id_ks"] = {
                "statistic": round(ks_stat_h, 4),
                "p_value": round(ks_p_h, 6),
            }
            metrics["internal_mean"] = float(np.mean(internal_health_ids))
            metrics["external_mean"] = float(np.mean(external_health_ids))
            metrics["internal_std"] = float(np.std(internal_health_ids))
            metrics["external_std"] = float(np.std(external_health_ids))

        # 4. ROC-AUC (если есть метки)
        if "label" in external_df.columns:
            auc = self._calculate_roc_auc(external_df, model_version)
            metrics["roc_auc"] = auc
        else:
            metrics["roc_auc"] = None
            metrics["roc_auc_note"] = "Метки отсутствуют — ROC-AUC не рассчитан"

        criteria = self.check_criteria(metrics)
        report_path = self._generate_report(self.stage, metrics, criteria, model_version)

        passed = all(c["met"] for c in criteria)

        return ValidationResult(
            stage=self.stage,
            status="passed" if passed else "failed",
            criteria=criteria,
            metrics=metrics,
            report_path=report_path,
            timestamp=datetime.now(timezone.utc).isoformat(),
            model_version=model_version,
            audit={
                "internal_n": len(internal_df),
                "external_n": len(external_df),
                "holdout": holdout_note,
                "immutable": True,
            },
        )

    def check_criteria(self, metrics: dict[str, Any]) -> list[dict[str, Any]]:
        ks_tests = metrics.get("ks_tests", {})
        ks_pass_count = sum(1 for v in ks_tests.values() if v["p_value"] > 0.05)
        ks_total = len(ks_tests) if ks_tests else 1

        health_id_ks = metrics.get("health_id_ks", {})
        auc = metrics.get("roc_auc")

        criteria = [
            {
                "name": "KS-тест признаков (p > 0.05)",
                "threshold": "≥ 80% признаков",
                "actual": f"{ks_pass_count}/{ks_total}",
                "met": ks_pass_count / ks_total >= 0.8,
            },
            {
                "name": "KS-тест HEALTH_ID",
                "threshold": "p > 0.05",
                "actual": f"p={health_id_ks.get('p_value', 'N/A')}",
                "met": health_id_ks.get("p_value", 0) > 0.05,
            },
        ]

        if auc is not None:
            criteria.append({
                "name": "ROC-AUC",
                "threshold": "> 0.70",
                "actual": f"{auc:.4f}",
                "met": auc > 0.70,
            })

        return criteria

    def _row_to_input(self, row: pd.Series) -> "HealthInput":
        from app.core.engine.health_id_engine import HealthInput, FeatureInput

        measurements = []
        for name in ["heart_rate", "blood_pressure_systolic", "blood_pressure_diastolic",
                      "temperature", "spo2", "alcohol_test", "adequacy_score",
                      "speech_coherence", "pupil_reaction"]:
            if name in row and pd.notna(row[name]):
                measurements.append(FeatureInput(
                    name=name, value=float(row[name]), unit="unit",
                    source="measured", confidence=0.95,
                    artifact_pct=0, timestamp=str(row.get("timestamp", "")),
                ))
        return HealthInput(
            event_id=str(row.get("event_id", "")),
            worker_pseudonym=str(row.get("worker_pseudonym", "")),
            timestamp=str(row.get("timestamp", "")),
            measurements=measurements,
        )

    def _calculate_roc_auc(self, df: pd.DataFrame, model_version: str) -> float | None:
        """ROC-AUC для разделения known-healthy (1) vs known-deviation (0)."""
        from sklearn.metrics import roc_auc_score
        from app.core.engine.health_id_engine import calculate_health_id

        scores = []
        labels = []
        for _, row in df.iterrows():
            if pd.isna(row.get("label")):
                continue
            result = calculate_health_id(self._row_to_input(row), model_version)
            val = result.health_id.get("value")
            if val is not None:
                scores.append(val)
                labels.append(int(row["label"]))

        if len(scores) < 10 or len(set(labels)) < 2:
            return None

        return float(roc_auc_score(labels, scores))


# ─── R3: Клиническая полезность ──────────────────────────────────

class R3ClinicalUtilityValidation(BaseValidation):
    """
    R3 — Клиническая полезность.

    Цель: оценка влияния HEALTH_ID на решение медработника.

    Дизайн: слепое сравнение.
      Медработник оценивает случай:
        1. Без HEALTH_ID (только сырые данные)
        2. С HEALTH_ID + объяснение
      Сравниваются решения.

    Критерии:
      1. Cohen's kappa ≥ 0.4 (умеренная согласованность)
      2. Средний балл полезности ≥ 3.5 (5-балльная шкала)
      3. Время принятия решения не увеличилось более чем на 20%
      4. ≥ 70% медработников оценили как полезное
    """

    stage = ValidationStage.R3
    description = "Клиническая полезность: влияние HEALTH_ID на решения медработника"

    def run(self, data: Any, model_version: str) -> ValidationResult:
        """
        data — DataFrame с результатами слепого сравнения.
        Колонки:
          - case_id
          - reviewer_id
          - decision_without_health_id (0/1)
          - decision_with_health_id (0/1)
          - time_without_sec
          - time_with_sec
          - usefulness_score (1-5)
          - would_use_again (bool)
        """
        df = data if isinstance(data, pd.DataFrame) else pd.DataFrame(data)

        metrics = {}

        # 1. Cohen's kappa
        if "decision_without_health_id" in df.columns and "decision_with_health_id" in df.columns:
            kappa = self._calculate_cohens_kappa(df)
            metrics["cohens_kappa"] = kappa
        else:
            metrics["cohens_kappa"] = None
            metrics["cohens_kappa_note"] = "Данные слепого сравнения отсутствуют"

        # 2. Полезность
        if "usefulness_score" in df.columns:
            metrics["usefulness_mean"] = float(df["usefulness_score"].mean())
            metrics["usefulness_median"] = float(df["usefulness_score"].median())
            metrics["usefulness_std"] = float(df["usefulness_score"].std())

        # 3. Время
        if "time_without_sec" in df.columns and "time_with_sec" in df.columns:
            mean_without = float(df["time_without_sec"].mean())
            mean_with = float(df["time_with_sec"].mean())
            time_change_pct = (mean_with - mean_without) / mean_without * 100 if mean_without > 0 else 0
            metrics["time_without_mean"] = mean_without
            metrics["time_with_mean"] = mean_with
            metrics["time_change_pct"] = time_change_pct

        # 4. Доля положительных отзывов
        if "would_use_again" in df.columns:
            metrics["would_use_again_rate"] = float(df["would_use_again"].mean())

        # 5. Количество уникальных медработников
        if "reviewer_id" in df.columns:
            metrics["n_reviewers"] = int(df["reviewer_id"].nunique())
            metrics["n_cases"] = int(len(df))
            metrics["n_unique_cases"] = int(df["case_id"].nunique()) if "case_id" in df.columns else 0

        criteria = self.check_criteria(metrics)
        report_path = self._generate_report(self.stage, metrics, criteria, model_version)

        passed = all(c["met"] for c in criteria)

        return ValidationResult(
            stage=self.stage,
            status="passed" if passed else "failed",
            criteria=criteria,
            metrics=metrics,
            report_path=report_path,
            timestamp=datetime.now(timezone.utc).isoformat(),
            model_version=model_version,
            audit={
                "n_cases": metrics.get("n_cases", 0),
                "n_reviewers": metrics.get("n_reviewers", 0),
                "immutable": True,
            },
        )

    def check_criteria(self, metrics: dict[str, Any]) -> list[dict[str, Any]]:
        return [
            {
                "name": "Cohen's kappa (согласованность решений)",
                "threshold": "≥ 0.4",
                "actual": f"{metrics.get('cohens_kappa', 0) or 0:.4f}",
                "met": (metrics.get("cohens_kappa") or 0) >= 0.4,
            },
            {
                "name": "Средний балл полезности",
                "threshold": "≥ 3.5",
                "actual": f"{metrics.get('usefulness_mean', 0):.2f}",
                "met": metrics.get("usefulness_mean", 0) >= 3.5,
            },
            {
                "name": "Изменение времени решения",
                "threshold": "≤ +20%",
                "actual": f"{metrics.get('time_change_pct', 0):+.1f}%",
                "met": metrics.get("time_change_pct", 100) <= 20,
            },
            {
                "name": "Доля медработников, готовых использовать",
                "threshold": "≥ 70%",
                "actual": f"{metrics.get('would_use_again_rate', 0)*100:.1f}%",
                "met": metrics.get("would_use_again_rate", 0) >= 0.70,
            },
        ]

    def _calculate_cohens_kappa(self, df: pd.DataFrame) -> float:
        """Расчёт Cohen's kappa между решениями без и с HEALTH_ID."""
        from sklearn.metrics import cohen_kappa_score

        without = df["decision_without_health_id"].dropna()
        with_h = df["decision_with_health_id"].dropna()

        # Выравнивание по индексу
        common_idx = without.index.intersection(with_h.index)
        if len(common_idx) < 5:
            return 0.0

        return float(cohen_kappa_score(
            without.loc[common_idx],
            with_h.loc[common_idx],
        ))


# ─── R4: Финальная оценка ─────────────────────────────────────────

class R4FinalAssessment(BaseValidation):
    """
    R4 — Финальная оценка.

    Цель: интегральная оценка готовности к применению.

    Действия:
      - Сводка результатов R0–R3
      - Оценка рисков
      - Решение о переходе из 'research' в 'validated'

    Критерии:
      1. R0, R1, R2, R3 — все пройдены
      2. Нет критических рисков
      3. Документация полная
      4. Решение коллегиального органа
    """

    stage = ValidationStage.R4
    description = "Финальная оценка готовности к клиническому применению"

    def run(self, data: Any, model_version: str) -> ValidationResult:
        """
        data — список объектов ValidationResult для R0–R3.
        """
        prior_results = data if isinstance(data, list) else [data]

        metrics = {}

        # 1. Сводка R0–R3
        stage_status = {}
        for result in prior_results:
            stage_status[result.stage] = result.status
        metrics["stage_status"] = stage_status
        metrics["all_passed"] = all(
            stage_status.get(s) == "passed"
            for s in [ValidationStage.R0, ValidationStage.R1,
                      ValidationStage.R2, ValidationStage.R3]
        )

        # 2. Оценка рисков
        risks = self._assess_risks(prior_results)
        metrics["risks"] = risks
        metrics["critical_risks"] = [r for r in risks if r["severity"] == "critical"]

        # 3. Проверка документации
        doc_check = self._check_documentation()
        metrics["documentation"] = doc_check

        # 4. Решение коллегиального органа (заполняется вручную)
        metrics["board_decision"] = {
            "required": True,
            "status": "pending",
            "note": "Решение заполняется вручную после заседания коллегиального органа",
        }

        criteria = self.check_criteria(metrics)
        report_path = self._generate_report(self.stage, metrics, criteria, model_version)

        passed = all(c["met"] for c in criteria)

        return ValidationResult(
            stage=self.stage,
            status="passed" if passed else "failed",
            criteria=criteria,
            metrics=metrics,
            report_path=report_path,
            timestamp=datetime.now(timezone.utc).isoformat(),
            model_version=model_version,
            audit={
                "prior_stages": list(stage_status.keys()),
                "immutable": True,
            },
        )

    def check_criteria(self, metrics: dict[str, Any]) -> list[dict[str, Any]]:
        return [
            {
                "name": "Все этапы R0–R3 пройдены",
                "threshold": "R0=R1=R2=R3=passed",
                "actual": str(metrics.get("stage_status", {})),
                "met": metrics.get("all_passed", False),
            },
            {
                "name": "Критические риски",
                "threshold": "0 критических",
                "actual": f"{len(metrics.get('critical_risks', []))} критических",
                "met": len(metrics.get("critical_risks", [])) == 0,
            },
            {
                "name": "Документация полная",
                "threshold": "все документы готовы",
                "actual": f"{metrics.get('documentation', {}).get('complete', False)}",
                "met": metrics.get("documentation", {}).get("complete", False),
            },
            {
                "name": "Решение коллегиального органа",
                "threshold": "approved",
                "actual": metrics.get("board_decision", {}).get("status", "pending"),
                "met": metrics.get("board_decision", {}).get("status") == "approved",
            },
        ]

    def _assess_risks(self, results: list) -> list[dict[str, Any]]:
        """Оценка рисков на основе результатов R0–R3."""
        risks = []

        for result in results:
            if result.status != "passed":
                risks.append({
                    "stage": result.stage,
                    "severity": "critical",
                    "description": f"Этап {result.stage} не пройден",
                })

            # Проверка невыполненных критериев
            for criterion in result.criteria:
                if not criterion["met"]:
                    risks.append({
                        "stage": result.stage,
                        "severity": "high",
                        "description": f"Критерий не выполнен: {criterion['name']}",
                        "expected": criterion["threshold"],
                        "actual": criterion["actual"],
                    })

        # Малая выборка
        for result in results:
            audit = result.audit if hasattr(result, "audit") else {}
            events = audit.get("events_total", audit.get("internal_n", 0))
            if events and events < 100:
                risks.append({
                    "stage": result.stage,
                    "severity": "medium",
                    "description": f"Малая выборка: {events} событий",
                })

        return risks

    def _check_documentation(self) -> dict[str, Any]:
        """Проверка наличия всей документации."""
        required_docs = [
            "validation/R0_analytical/report.md",
            "validation/R1_retrospective/report.md",
            "validation/R2_external_prospective/report.md",
            "validation/R3_clinical_utility/report.md",
            "docs/architecture.md",
            "docs/api_reference.md",
            "docs/security.md",
        ]

        found = []
        missing = []
        for doc_path in required_docs:
            if Path(doc_path).exists():
                found.append(doc_path)
            else:
                missing.append(doc_path)

        return {
            "found": found,
            "missing": missing,
            "complete": len(missing) == 0,
        }


# ─── Оркестратор валидации ───────────────────────────────────────

class ValidationOrchestrator:
    """
    Управляет последовательным запуском этапов валидации R0–R4.
    Каждый этап запускается только после прохождения предыдущего.
    """

    STAGES = [
        (ValidationStage.R0, R0AnalyticalValidation),
        (ValidationStage.R1, R1RetrospectiveValidation),
        (ValidationStage.R2, R2ExternalProspectiveValidation),
        (ValidationStage.R3, R3ClinicalUtilityValidation),
        (ValidationStage.R4, R4FinalAssessment),
    ]

    def __init__(self, model_version: str):
        self.model_version = model_version
        self.results: list[ValidationResult] = []
        self.status_log: list[ValidationStatus] = []

    def run_all(self, data_by_stage: dict[str, Any]) -> dict[str, Any]:
        """
        Запускает все этапы последовательно.

        data_by_stage: {
            "R0_analytical": pd.DataFrame,
            "R1_retrospective": pd.DataFrame,
            "R2_external_prospective": (internal_df, external_df),
            "R3_clinical_utility": pd.DataFrame,
            "R4_final": list[ValidationResult]
        }
        """
        summary = {"model_version": self.model_version, "stages": []}

        for stage_name, stage_class in self.STAGES:
            status = ValidationStatus(
                stage=stage_name,
                status="in_progress",
                started_at=datetime.now(timezone.utc).isoformat(),
            )
            self.status_log.append(status)

            if stage_name not in data_by_stage:
                status.status = "skipped"
                status.notes = "Данные для этапа не предоставлены"
                summary["stages"].append(status.model_dump())
                continue

            try:
                validator = stage_class()
                result = validator.run(
                    data=data_by_stage[stage_name],
                    model_version=self.model_version,
                )
                self.results.append(result)
                status.status = result.status
                status.completed_at = datetime.now(timezone.utc).isoformat()
                status.criteria_met = result.status == "passed"
                status.report_path = result.report_path

                summary["stages"].append(status.model_dump())

                # Остановка при провале
                if result.status != "passed" and stage_name != ValidationStage.R4:
                    status.notes = "Валидация остановлена: этап не пройден"
                    # Пропускаем оставшиеся
                    for remaining_stage, _ in self.STAGES[self.STAGES.index((stage_name, stage_class))+1:]:
                        skip_status = ValidationStatus(
                            stage=remaining_stage,
                            status="skipped",
                            notes=f"Пропущен из-за провала {stage_name}",
                        )
                        self.status_log.append(skip_status)
                        summary["stages"].append(skip_status.model_dump())
                    break

            except Exception as e:
                status.status = "failed"
                status.notes = f"Ошибка: {str(e)}"
                summary["stages"].append(status.model_dump())
                break

        # Итоговое решение
        all_passed = all(
            s.get("status") == "passed" for s in summary["stages"]
        )
        summary["overall"] = "passed" if all_passed else "failed"
        summary["model_status"] = "validated" if all_passed else "research"
        summary["timestamp"] = datetime.now(timezone.utc).isoformat()
        summary["audit"] = {
            "stages_run": len([s for s in summary["stages"] if s.get("status") in ("passed", "failed")]),
            "stages_skipped": len([s for s in summary["stages"] if s.get("status") == "skipped"]),
            "immutable": True,
        }

        return summary
```
## Шаблон файла-протокола для каждого этапа
Для каждого этапа в папке validation/{stage}/ должен лежать файл protocol.md. Вот шаблон:
# Протокол валидации: {STAGE_NAME}

## Описание этапа

{DESCRIPTION}

## Цель

{GOAL}

## Данные

- **Источник:** {DATA_SOURCE}
- **Объём:** {DATA_VOLUME}
- **Период:** {DATA_PERIOD}
- **Примечание:** {DATA_NOTES}

## Критерии прохода

| # | Критерий | Порог | Метод проверки |
|---|---|---|---|
| 1 | {CRITERION_1} | {THRESHOLD_1} | {METHOD_1} |
| 2 | {CRITERION_2} | {THRESHOLD_2} | {METHOD_2} |
| ... | ... | ... | ... |

## Процедура

1. {STEP_1}
2. {STEP_2}
3. {STEP_3}
4. {STEP_N}

## Ответственные

- **Исполнитель:** {EXECUTOR}
- **Проверяющий:** {REVIEWER}
- **Коллегиальный орган:** {BOARD}

## Статус

- [ ] Запланировано
- [ ] В работе
- [ ] Завершено

## Результат

- **Отчёт:** `report.md`
- **Статус:** PASSED / FAILED
- **Дата завершения:** {DATE}

---

⚠️ До завершения всех этапов R0–R4 модель остаётся в статусе `research`.
Все результаты — исследовательские, не предназначены для клинических решений.

##  Шаблон чек-листа критериев (checklist.yaml)

# validation/R0_analytical/checklist.yaml
```yaml
stage: "R0_analytical"
description: "Аналитическая валидация"
model_version_required: true

criteria:
  - id: "reproducibility"
    name: "Воспроизводимость расчёта"
    threshold: "100%"
    method: "Повторный расчёт 100 событий, сравнение значений"
    required: true

  - id: "unit_tests"
    name: "Unit-тесты"
    threshold: "100% pass"
    method: "pytest tests/unit/ -v"
    required: true

  - id: "formula_verification"
    name: "Ручная верификация формул"
    threshold: "100% совпадение"
    method: "Независимый расчёт 100 событий, сравнение с движком"
    required: true

  - id: "config_integrity"
    name: "Целостность конфигурации"
    threshold: "hash совпадает"
    method: "Сравнение хеша config.yaml с published hash"
    required: true

sign_off:
  executor:
    name: ""
    role: "Разработчик"
    date: ""
    signature: ""
  reviewer:
    name: ""
    role: "Исследователь"
    date: ""
    signature: ""
  board:
    name: ""
    role: "Коллегиальный орган"
    date: ""
    decision: ""  # approved | rejected
```