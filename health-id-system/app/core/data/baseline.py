"""
app/core/data/baseline.py

Модуль 4: Персональные коридоры (baseline).

Расчёт индивидуальных коридоров норм для каждого работника
на основе его предыдущих качественных измерений.

Коридоры используются для определения персонального отклонения —
отличается ли текущий показатель от привычного для данного человека.

КЛЮЧЕВЫЕ ПРАВИЛА:
  1. Текущее измерение ИСКЛЮЧАЕТСЯ из baseline (анти-утечка)
  2. Минимум 3 качественные точки для построения коридора
  3. Окно наблюдения — настраиваемое (default: 90 дней)
  4. Baseline пересчитывается для каждого нового события
  5. При дрейфе (t-тест, p < 0.05) — пометка baseline_drift
"""

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import numpy as np
from scipy import stats as scipy_stats

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import ExaminationEvent, VitalMeasurement, MentalAssessment
from app.core.data.anti_leak import (
    fetch_history_excluding_current,
    collect_feature_values,
    verify_exclusion,
)


# ---------------------------------------------------------------------------
# Структуры данных
# ---------------------------------------------------------------------------

@dataclass
class FeatureBaseline:
    """Коридор нормы для одного признака."""
    name: str
    available: bool
    mean: float = 0.0
    std: float = 0.0
    median: float = 0.0
    p5: float = 0.0
    p95: float = 0.0
    corridor_low: float = 0.0
    corridor_high: float = 0.0
    n_points: int = 0
    window_days: int = 90
    excluded_event: str = ""
    baseline_drift: bool = False
    drift_p_value: float = 1.0
    reason: str = ""

    def to_dict(self) -> dict:
        return {
            "available": self.available,
            "mean": round(self.mean, 2) if self.available else None,
            "std": round(self.std, 2) if self.available else None,
            "median": round(self.median, 2) if self.available else None,
            "p5": round(self.p5, 2) if self.available else None,
            "p95": round(self.p95, 2) if self.available else None,
            "corridor_low": round(self.corridor_low, 2) if self.available else None,
            "corridor_high": round(self.corridor_high, 2) if self.available else None,
            "n_points": self.n_points,
            "window_days": self.window_days,
            "excluded_event": self.excluded_event,
            "baseline_drift": self.baseline_drift,
            "drift_p_value": round(self.drift_p_value, 4) if self.available else None,
            "reason": self.reason or None,
        }


@dataclass
class Baseline:
    """Полный baseline для одного работника."""
    available: bool
    worker_pseudonym: str
    features: dict[str, FeatureBaseline] = field(default_factory=dict)
    n_historical_events: int = 0
    window_days: int = 90
    excluded_event: str = ""
    reason: str = ""
    calculated_at: str = ""

    def to_dict(self) -> dict:
        return {
            "available": self.available,
            "worker_pseudonym": self.worker_pseudonym,
            "n_historical_events": self.n_historical_events,
            "window_days": self.window_days,
            "excluded_event": self.excluded_event,
            "calculated_at": self.calculated_at,
            "reason": self.reason or None,
            "features": {k: v.to_dict() for k, v in self.features.items()},
        }


# ---------------------------------------------------------------------------
# Проверка дрейфа (t-тест Стьюдента)
# ---------------------------------------------------------------------------

def check_drift(
    historical_values: list[float],
    current_value: float,
    alpha: float = 0.05,
) -> tuple[bool, float]:
    """
    Проверка дрейфа baseline с помощью одновыборочного t-теста Стьюдента.

    H0: текущее значение принадлежит тому же распределению, что и история.
    H1: текущее значение значимо отличается (дрейф).

    Args:
        historical_values: значения из истории (без текущего)
        current_value:     текущее значение
        alpha:             уровень значимости (default: 0.05)

    Returns:
        (drift_detected, p_value)
    """
    if len(historical_values) < 3:
        return False, 1.0

    try:
        t_stat, p_value = scipy_stats.ttest_1samp(historical_values, current_value)
        # Если p_value — nan (например, все значения одинаковые)
        if np.isnan(p_value):
            return False, 1.0
        return p_value < alpha, float(p_value)
    except Exception:
        return False, 1.0


# ---------------------------------------------------------------------------
# Проверка отклонения от коридора
# ---------------------------------------------------------------------------

@dataclass
class DeviationResult:
    """Результат проверки отклонения текущего значения от коридора."""
    feature_name: str
    current_value: float
    corridor_low: float
    corridor_high: float
    in_corridor: bool
    deviation_type: str       # "none" | "above_corridor" | "below_corridor"
    sigma: float              # отклонение в сигмах (0.0 если в коридоре)
    severity: str             # "normal" | "warning" | "critical"

    def to_dict(self) -> dict:
        return {
            "feature": self.feature_name,
            "current_value": self.current_value,
            "corridor": [round(self.corridor_low, 2), round(self.corridor_high, 2)],
            "in_corridor": self.in_corridor,
            "deviation_type": self.deviation_type,
            "sigma": round(self.sigma, 2),
            "severity": self.severity,
        }


def check_deviation(
    current_value: float,
    baseline: FeatureBaseline,
    feature_name: str = "",
) -> DeviationResult:
    """
    Проверяет, выходит ли текущее значение за персональный коридор.

    Коридор: mean ± 2σ
    Сигмы:   |value - mean| / std

    Severity:
      - normal  — в коридоре
      - warning — 2–3σ за пределами
      - critical — > 3σ
    """
    if not baseline.available or baseline.std == 0:
        return DeviationResult(
            feature_name=feature_name or baseline.name,
            current_value=current_value,
            corridor_low=baseline.corridor_low,
            corridor_high=baseline.corridor_high,
            in_corridor=True,
            deviation_type="none",
            sigma=0.0,
            severity="normal",
        )

    low = baseline.corridor_low
    high = baseline.corridor_high
    sigma_count = abs(current_value - baseline.mean) / baseline.std

    if low <= current_value <= high:
        return DeviationResult(
            feature_name=feature_name or baseline.name,
            current_value=current_value,
            corridor_low=low,
            corridor_high=high,
            in_corridor=True,
            deviation_type="none",
            sigma=0.0,
            severity="normal",
        )

    deviation_type = "above_corridor" if current_value > high else "below_corridor"
    severity = "critical" if sigma_count > 3 else "warning"

    return DeviationResult(
        feature_name=feature_name or baseline.name,
        current_value=current_value,
        corridor_low=low,
        corridor_high=high,
        in_corridor=False,
        deviation_type=deviation_type,
        sigma=round(sigma_count, 2),
        severity=severity,
    )


# ---------------------------------------------------------------------------
# Главная функция расчёта baseline
# ---------------------------------------------------------------------------

# Признаки, для которых строятся коридоры
BASELINE_FEATURES = {
    "vitals": [
        "heart_rate",
        "blood_pressure_systolic",
        "blood_pressure_diastolic",
        "temperature",
        "spo2",
    ],
    "mental": [
        "adequacy_score",
        "speech_coherence",
        "pupil_reaction",
    ],
}

# alcohol_test не включён — это бинарный показатель, коридор не имеет смысла


def calculate_baseline(
    session: Session,
    worker_pseudonym: str,
    current_event_id: str,
    window_days: int = 90,
) -> Baseline:
    """
    Расчёт персональных коридоров с исключением текущей точки.

    Алгоритм:
      1. Загрузка истории (без текущего события, только качественные)
      2. Для каждого признака:
         a. Сбор значений из истории
         b. Если < 3 точек — коридор недоступен
         c. Расчёт mean, std, median, p5, p95
         d. Коридор: mean ± 2σ
         e. Проверка дрейфа (t-тест Стьюдента)
      3. Фиксация исключённого event_id (для аудита)

    Args:
        session:            SQLAlchemy-сессия
        worker_pseudonym:   hash(SNP_ID)
        current_event_id:   event_id текущего события (ИСКЛЮЧАЕТСЯ)
        window_days:        окно наблюдения (default: 90)

    Returns:
        Baseline — объект с коридорами для каждого признака
    """
    # --- 1. Загрузка истории ---
    history = fetch_history_excluding_current(
        session=session,
        worker_pseudonym=worker_pseudonym,
        current_event_id=current_event_id,
        window_days=window_days,
    )

    # --- Проверка исключения (аудит) ---
    if not verify_exclusion(history, current_event_id):
        raise RuntimeError(
            f"ANTI-LEAK VIOLATION: current event {current_event_id} "
            f"found in baseline history!"
        )

    # --- Если истории недостаточно ---
    if len(history) < 3:
        return Baseline(
            available=False,
            worker_pseudonym=worker_pseudonym,
            n_historical_events=len(history),
            window_days=window_days,
            excluded_event=current_event_id,
            reason="insufficient_history",
            calculated_at=datetime.utcnow().isoformat(),
        )

    # --- 2. Расчёт по каждому признаку ---
    baseline = Baseline(
        available=True,
        worker_pseudonym=worker_pseudonym,
        n_historical_events=len(history),
        window_days=window_days,
        excluded_event=current_event_id,
        calculated_at=datetime.utcnow().isoformat(),
    )

    # Текущие значения (для проверки дрейфа)
    current_event = session.execute(
        select(ExaminationEvent).where(
            ExaminationEvent.event_id == current_event_id
        )
    ).scalar_one_or_none()

    current_vitals = {}
    current_mental = {}

    if current_event:
        vitals = session.execute(
            select(VitalMeasurement).where(
                VitalMeasurement.event_id == current_event.id
            )
        ).scalars().all()
        current_vitals = {v.feature_name: float(v.value) for v in vitals if v.value is not None}

        mental = session.execute(
            select(MentalAssessment).where(
                MentalAssessment.event_id == current_event.id
            )
        ).scalar_one_or_none()

        if mental:
            if mental.adequacy_score is not None:
                current_mental["adequacy_score"] = float(mental.adequacy_score)
            if mental.speech_coherence is not None:
                current_mental["speech_coherence"] = float(mental.speech_coherence)
            if mental.pupil_reaction is not None:
                current_mental["pupil_reaction"] = float(mental.pupil_reaction)

    # --- Витальные признаки ---
    for feature_name in BASELINE_FEATURES["vitals"]:
        values = collect_feature_values(session, history, feature_name, source="vitals")

        if len(values) < 3:
            baseline.features[feature_name] = FeatureBaseline(
                name=feature_name,
                available=False,
                n_points=len(values),
                window_days=window_days,
                excluded_event=current_event_id,
                reason="insufficient_points",
            )
            continue

        mean_val = float(np.mean(values))
        std_val = float(np.std(values, ddof=0))

        # Проверка дрейфа
        current_val = current_vitals.get(feature_name)
        drift = False
        p_val = 1.0
        if current_val is not None:
            drift, p_val = check_drift(values, current_val)

        baseline.features[feature_name] = FeatureBaseline(
            name=feature_name,
            available=True,
            mean=mean_val,
            std=std_val,
            median=float(np.median(values)),
            p5=float(np.percentile(values, 5)),
            p95=float(np.percentile(values, 95)),
            corridor_low=mean_val - 2 * std_val,
            corridor_high=mean_val + 2 * std_val,
            n_points=len(values),
            window_days=window_days,
            excluded_event=current_event_id,
            baseline_drift=drift,
            drift_p_value=p_val,
        )

    # --- Психофизиологические признаки ---
    for feature_name in BASELINE_FEATURES["mental"]:
        values = collect_feature_values(session, history, feature_name, source="mental")

        if len(values) < 3:
            baseline.features[feature_name] = FeatureBaseline(
                name=feature_name,
                available=False,
                n_points=len(values),
                window_days=window_days,
                excluded_event=current_event_id,
                reason="insufficient_points",
            )
            continue

        mean_val = float(np.mean(values))
        std_val = float(np.std(values, ddof=0))

        current_val = current_mental.get(feature_name)
        drift = False
        p_val = 1.0
        if current_val is not None:
            drift, p_val = check_drift(values, current_val)

        baseline.features[feature_name] = FeatureBaseline(
            name=feature_name,
            available=True,
            mean=mean_val,
            std=std_val,
            median=float(np.median(values)),
            p5=float(np.percentile(values, 5)),
            p95=float(np.percentile(values, 95)),
            corridor_low=mean_val - 2 * std_val,
            corridor_high=mean_val + 2 * std_val,
            n_points=len(values),
            window_days=window_days,
            excluded_event=current_event_id,
            baseline_drift=drift,
            drift_p_value=p_val,
        )

    return baseline

def _check_population_norms(results: list[DeviationResult]) -> list[DeviationResult]:
    """
    Дополнительная проверка против популяционных норм.

    Если значение внутри персонального коридора, но вне популяционной нормы,
    помечает его как отклонение (above_norm / below_norm).
    """
    try:
        from app.core.engine.model_config import get_default_config
        config = get_default_config()
        normal_ranges = {}
        for comp in config.components.values():
            for feat in comp.features:
                if feat.normal_range:
                    normal_ranges[feat.name] = (
                        float(feat.normal_range[0]),
                        float(feat.normal_range[1]),
                    )
    except Exception:
        return results

    for dev in results:
        nr = normal_ranges.get(dev.feature_name)
        if not nr:
            continue

        nr_low, nr_high = nr

        # Если уже outside corridor — оставляем как есть
        if not dev.in_corridor:
            continue

        # Значение в коридоре, но вне популяционной нормы
        if dev.current_value > nr_high:
            dev.in_corridor = False
            dev.deviation_type = "above_norm"
            dev.sigma = abs(dev.current_value - nr_high) / (nr_high - nr_low) if nr_high != nr_low else 2.0
            dev.sigma = round(dev.sigma, 2)
            dev.severity = "critical" if dev.sigma >= 3 else "warning"
        elif dev.current_value < nr_low:
            dev.in_corridor = False
            dev.deviation_type = "below_norm"
            dev.sigma = abs(nr_low - dev.current_value) / (nr_high - nr_low) if nr_high != nr_low else 2.0
            dev.sigma = round(dev.sigma, 2)
            dev.severity = "critical" if dev.sigma >= 3 else "warning"

    return results


# ---------------------------------------------------------------------------
# Проверка всех признаков текущего события
# ---------------------------------------------------------------------------

def check_all_deviations(
    session: Session,
    baseline: Baseline,
    current_event_id: str,
) -> list[DeviationResult]:
    """... (ваша существующая документация) ..."""
    if not baseline.available:
        return []

    event = session.execute(
        select(ExaminationEvent).where(
            ExaminationEvent.event_id == current_event_id
        )
    ).scalar_one_or_none()

    if event is None:
        return []

    results = []

    vitals = session.execute(
        select(VitalMeasurement).where(VitalMeasurement.event_id == event.id)
    ).scalars().all()

    for vital in vitals:
        fb = baseline.features.get(vital.feature_name)
        if fb and fb.available and vital.value is not None:
            dev = check_deviation(float(vital.value), fb, vital.feature_name)
            results.append(dev)

    mental = session.execute(
        select(MentalAssessment).where(MentalAssessment.event_id == event.id)
    ).scalar_one_or_none()

    if mental:
        mental_map = {
            "adequacy_score": mental.adequacy_score,
            "speech_coherence": mental.speech_coherence,
            "pupil_reaction": mental.pupil_reaction,
        }

        for name, val in mental_map.items():
            if val is None:
                continue
            fb = baseline.features.get(name)
            if fb and fb.available:
                dev = check_deviation(float(val), fb, name)
                results.append(dev)

    # --- Постобработка: проверка популяционных норм ---
    results = _check_population_norms(results)

    return results

# ---------------------------------------------------------------------------
# CLI-запуск для тестирования
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys
    from datetime import timedelta
    from sqlalchemy import create_engine

    from app.db.models import Base, SocialContext
    from app.core.data.intake import intake_event

    db_url = sys.argv[1] if len(sys.argv) > 1 else "sqlite:///health_id.db"
    engine = create_engine(db_url)
    Base.metadata.create_all(engine)

    worker = "hash_worker_baseline_test"

    # Создаём 5 исторических событий (разные даты)
    historical_events = [
        ("hist_001", "2026-06-15T10:00:00+04:00", 72, 120, 78, 36.6, 98, 8, 8, 9),
        ("hist_002", "2026-07-01T10:00:00+04:00", 74, 122, 80, 36.7, 97, 8, 7, 9),
        ("hist_003", "2026-07-15T10:00:00+04:00", 71, 118, 76, 36.5, 98, 9, 8, 8),
        ("hist_004", "2026-08-01T10:00:00+04:00", 73, 125, 82, 36.8, 97, 8, 8, 9),
        ("hist_005", "2026-08-15T10:00:00+04:00", 70, 120, 78, 36.6, 98, 9, 8, 9),
    ]

    # Текущее событие с отклонением (АД сист. 145 — выше персонального коридора)
    current_event_id = "curr_001"
    current_ts = "2026-09-15T10:30:00+04:00"

    def make_payload(event_id, ts, hr, bp_s, bp_d, temp, spo2, adeq, speech, pupil):
        return {
            "event_id": event_id,
            "event_type": "periodic_medical_examination",
            "worker_pseudonym": worker,
            "timestamp": ts,
            "measurements": {
                "vitals": [
                    {"name": "heart_rate", "value": hr, "unit": "bpm",
                     "measurement_protocol": "std", "confidence": 0.95,
                     "artifact_pct": 2, "timestamp": ts},
                    {"name": "blood_pressure_systolic", "value": bp_s, "unit": "mmHg",
                     "measurement_protocol": "std", "confidence": 0.92,
                     "artifact_pct": 1, "timestamp": ts},
                    {"name": "blood_pressure_diastolic", "value": bp_d, "unit": "mmHg",
                     "measurement_protocol": "std", "confidence": 0.92,
                     "artifact_pct": 1, "timestamp": ts},
                    {"name": "temperature", "value": temp, "unit": "°C",
                     "measurement_protocol": "std", "confidence": 0.98,
                     "artifact_pct": 0, "timestamp": ts},
                    {"name": "spo2", "value": spo2, "unit": "%",
                     "measurement_protocol": "std", "confidence": 0.96,
                     "artifact_pct": 0, "timestamp": ts},
                    {"name": "alcohol_test", "value": 0.00, "unit": "mg/l",
                     "measurement_protocol": "std", "confidence": 0.99,
                     "artifact_pct": 0, "timestamp": ts},
                ],
                "mental": [
                    {"name": "adequacy_score", "value": adeq, "confidence": 0.9,
                     "source": "measured", "timestamp": ts},
                    {"name": "speech_coherence", "value": speech, "confidence": 0.85,
                     "source": "derived", "timestamp": ts},
                    {"name": "pupil_reaction", "value": pupil, "confidence": 0.85,
                     "source": "measured", "timestamp": ts},
                ],
                "context": {
                    "workplace": "plant_A",
                    "shift": "morning",
                    "examination_type": "periodic",
                },
            },
            "metadata": {
                "mis_source": "ECOZ",
                "transmission_id": f"trans_{event_id}",
                "transmission_timestamp": ts,
            },
        }

    with Session(engine) as session:
        # 1. Загрузка исторических событий
        print("=== ЗАГРУЗКА ИСТОРИИ ===")
        for eid, ts, hr, bp_s, bp_d, temp, spo2, adeq, speech, pupil in historical_events:
            payload = make_payload(eid, ts, hr, bp_s, bp_d, temp, spo2, adeq, speech, pupil)
            intake_event(payload, session)

        # 2. Загрузка текущего события (с отклонением АД)
        print()
        print("=== ЗАГРУЗКА ТЕКУЩЕГО СОБЫТИЯ ===")
        # АД сист. = 145 (история: 118-125, коридор ~117-127)
        current_payload = make_payload(
            current_event_id, current_ts,
            hr=75, bp_s=145, bp_d=85, temp=36.6, spo2=98,
            adeq=8, speech=8, pupil=9,
        )
        intake_event(current_payload, session)

        # 3. Расчёт baseline
        print()
        print("=== РАСЧЁТ BASELINE ===")
        baseline = calculate_baseline(
            session=session,
            worker_pseudonym=worker,
            current_event_id=current_event_id,
            window_days=90,
        )

        print(f"  available:     {baseline.available}")
        print(f"  history events: {baseline.n_historical_events}")
        print(f"  excluded:      {baseline.excluded_event}")
        print()
        print("  Коридоры:")
        for name, fb in baseline.features.items():
            if fb.available:
                print(f"    {name:30s}  corridor=[{fb.corridor_low:.1f}, {fb.corridor_high:.1f}]  "
                      f"mean={fb.mean:.1f}  std={fb.std:.1f}  n={fb.n_points}  "
                      f"drift={'⚠️' if fb.baseline_drift else '✅'} (p={fb.drift_p_value:.4f})")
            else:
                print(f"    {name:30s}  ❌ {fb.reason} (n={fb.n_points})")

        # 4. Проверка отклонений
        print()
        print("=== ПРОВЕРКА ОТКЛОНЕНИЙ ===")
        deviations = check_all_deviations(session, baseline, current_event_id)

        any_deviation = False
        for dev in deviations:
            status = "✅ в коридоре" if dev.in_corridor else f"⚠️ {dev.deviation_type} ({dev.sigma}σ, {dev.severity})"
            print(f"  {dev.feature_name:30s}  current={dev.current_value}  "
                  f"corridor=[{dev.corridor_low:.1f}, {dev.corridor_high:.1f}]  → {status}")
            if not dev.in_corridor:
                any_deviation = True

        # 5. Проверки
        print()
        print("=== ПРОВЕРКИ ===")

        # Анти-утечка: текущее событие исключено
        assert baseline.excluded_event == current_event_id
        print(f"  ✅ Анти-утечка: текущее событие исключено ({baseline.excluded_event})")

        # АД сист. 145 должно выйти за коридор (история 118-125)
        bp_dev = next((d for d in deviations if d.feature_name == "blood_pressure_systolic"), None)
        assert bp_dev is not None
        assert not bp_dev.in_corridor
        assert bp_dev.deviation_type == "above_corridor"
        assert bp_dev.severity in ("warning", "critical")
        print(f"  ✅ АД сист. 145 > коридор [{bp_dev.corridor_low:.1f}, {bp_dev.corridor_high:.1f}] → {bp_dev.deviation_type}")

        # ЧСС 75 должно быть в коридоре (история 70-74)
        hr_dev = next((d for d in deviations if d.feature_name == "heart_rate"), None)
        assert hr_dev is not None
        assert hr_dev.in_corridor
        print(f"  ✅ ЧСС 75 в коридоре [{hr_dev.corridor_low:.1f}, {hr_dev.corridor_high:.1f}]")

        # Дрейф АД: p-value должен быть < 0.05 (145 vs 118-125)
        bp_fb = baseline.features["blood_pressure_systolic"]
        assert bp_fb.baseline_drift
        print(f"  ✅ Дрейф АД: p={bp_fb.drift_p_value:.4f} < 0.05 → baseline_drift=True")

        print()
        print("  🎉 Все проверки пройдены!")
