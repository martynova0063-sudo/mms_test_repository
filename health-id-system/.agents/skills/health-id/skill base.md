# Шаблон контроля качества видео для верификации
"""
Контроль качества видеопотока для биометрической верификации.
Все результаты сохраняются в аудит. Исходные видео не хранятся.
"""
from __future__ import annotations

import cv2
import numpy as np
from dataclasses import dataclass, field
from typing import Any


QUALITY_CHECKS = {
    "resolution": {"min": (640, 480), "actual": None},
    "fps": {"min": 15, "actual": None},
    "lighting": {"min_lux": 100, "actual": None},
    "face_visibility": {"min_area_pct": 5, "actual": None},
    "blur": {"max_variance": 35, "actual": None},
    "occlusion": {"max_pct": 10, "actual": None},
    "angle": {"max_yaw": 25, "max_pitch": 20, "max_roll": 15, "actual": None},
    "duration": {"min_sec": 3, "actual": None},
}


@dataclass
class QualityResult:
    overall: str  # "pass" | "warning" | "fail"
    checks: dict[str, dict[str, Any]] = field(default_factory=dict)
    blocking_issues: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def check_video_quality(
    video_path: str,
    face_detector: Any = None,
) -> QualityResult:
    """
    Полная проверка качества видеопотока.
    Возвращает структурированный отчёт.
    """
    result = QualityResult(overall="pass")

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        result.overall = "fail"
        result.blocking_issues.append("cannot_open_video")
        return result

    # Метаданные видео
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration_sec = frame_count / fps if fps > 0 else 0

    # 1. Разрешение
    min_w, min_h = QUALITY_CHECKS["resolution"]["min"]
    res_pass = width >= min_w and height >= min_h
    result.checks["resolution"] = {
        "status": "pass" if res_pass else "fail",
        "actual": (width, height),
        "required": (min_w, min_h),
    }
    if not res_pass:
        result.blocking_issues.append("resolution_too_low")

    # 2. FPS
    fps_pass = fps >= QUALITY_CHECKS["fps"]["min"]
    result.checks["fps"] = {
        "status": "pass" if fps_pass else "warning",
        "actual": round(fps, 1),
        "required": QUALITY_CHECKS["fps"]["min"],
    }
    if not fps_pass:
        result.warnings.append("low_fps")

    # 3. Длительность
    dur_pass = duration_sec >= QUALITY_CHECKS["duration"]["min_sec"]
    result.checks["duration"] = {
        "status": "pass" if dur_pass else "fail",
        "actual": round(duration_sec, 2),
        "required": QUALITY_CHECKS["duration"]["min_sec"],
    }
    if not dur_pass:
        result.blocking_issues.append("duration_too_short")

    # Покадровый анализ (каждый N-й кадр)
    sample_interval = max(1, frame_count // 30)  # ~30 кадров для анализа
    blur_values = []
    face_areas = []
    lighting_values = []
    angles = []
    occlusion_flags = []

    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % sample_interval == 0:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

            # Размытие (Laplacian variance — выше = резче)
            blur_var = cv2.Laplacian(gray, cv2.CV_64F).var()
            blur_values.append(blur_var)

            # Освещённость (средняя яркость как proxy для lux)
            brightness = np.mean(gray)
            lighting_values.append(float(brightness))

            # Обнаружение лица
            if face_detector is not None:
                faces = face_detector.detect(frame)
                if faces:
                    face = faces[0]
                    face_area = (face.w * face.h) / (width * height) * 100
                    face_areas.append(face_area)

                    # Углы наклона головы
                    if hasattr(face, "yaw"):
                        angles.append({
                            "yaw": face.yaw,
                            "pitch": face.pitch,
                            "roll": face.roll,
                        })

                    # Окклюзия (упрощённая проверка)
                    if hasattr(face, "occlusion_pct"):
                        if face.occlusion_pct > QUALITY_CHECKS["occlusion"]["max_pct"]:
                            occlusion_flags.append(frame_idx)
                else:
                    face_areas.append(0.0)

        frame_idx += 1

    cap.release()

    # 4. Размытие
    if blur_values:
        avg_blur = float(np.mean(blur_values))
        blur_pass = avg_blur >= QUALITY_CHECKS["blur"]["max_variance"]
        result.checks["blur"] = {
            "status": "pass" if blur_pass else "warning",
            "actual": round(avg_blur, 2),
            "required": QUALITY_CHECKS["blur"]["max_variance"],
        }
        if not blur_pass:
            result.warnings.append("blur_detected")

    # 5. Видимость лица
    if face_areas:
        avg_face_area = float(np.mean(face_areas))
        face_pass = avg_face_area >= QUALITY_CHECKS["face_visibility"]["min_area_pct"]
        result.checks["face_visibility"] = {
            "status": "pass" if face_pass else "fail",
            "actual": round(avg_face_area, 2),
            "required": QUALITY_CHECKS["face_visibility"]["min_area_pct"],
        }
        if not face_pass:
            result.blocking_issues.append("face_too_small")

    # 6. Освещённость
    if lighting_values:
        avg_light = float(np.mean(lighting_values))
        # Proxy: brightness > 60 ≈ приемлемое освещение
        light_pass = avg_light >= 60
        result.checks["lighting"] = {
            "status": "pass" if light_pass else "warning",
            "actual": round(avg_light, 2),
            "note": "Brightness-based proxy, not true lux measurement",
        }
        if not light_pass:
            result.warnings.append("low_lighting")

    # 7. Углы наклона
    if angles:
        max_yaw = max(abs(a["yaw"]) for a in angles)
        max_pitch = max(abs(a["pitch"]) for a in angles)
        max_roll = max(abs(a["roll"]) for a in angles)

        yaw_pass = max_yaw <= QUALITY_CHECKS["angle"]["max_yaw"]
        pitch_pass = max_pitch <= QUALITY_CHECKS["angle"]["max_pitch"]
        roll_pass = max_roll <= QUALITY_CHECKS["angle"]["max_roll"]

        angle_pass = yaw_pass and pitch_pass and roll_pass
        result.checks["angle"] = {
            "status": "pass" if angle_pass else "warning",
            "actual": {
                "max_yaw": round(max_yaw, 1),
                "max_pitch": round(max_pitch, 1),
                "max_roll": round(max_roll, 1),
            },
            "required": {
                "max_yaw": QUALITY_CHECKS["angle"]["max_yaw"],
                "max_pitch": QUALITY_CHECKS["angle"]["max_pitch"],
                "max_roll": QUALITY_CHECKS["angle"]["max_roll"],
            },
        }
        if not angle_pass:
            result.warnings.append("head_angle_exceeded")

    # 8. Окклюзия
    occlusion_pass = len(occlusion_flags) == 0
    result.checks["occlusion"] = {
        "status": "pass" if occlusion_pass else "warning",
        "actual": len(occlusion_flags),
        "required": 0,
    }
    if not occlusion_pass:
        result.warnings.append("occlusion_detected")

    # Итоговый статус
    if result.blocking_issues:
        result.overall = "fail"
    elif result.warnings:
        result.overall = "warning"
    else:
        result.overall = "pass"

    return result

# Шаблон маршрутизации результатов верификации
```python
"""
Маршрутизация результатов биометрической верификации.
Определяет: verified / manual_review / not_verified.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


# Пороговые значения (настраиваемые)
THRESHOLDS = {
    "match_high": 0.62,       # >= → verified
    "match_low": 0.45,        # < → not_verified
    "liveness_pass": 0.70,    # >= → liveness confirmed
    "liveness_warning": 0.50, # >= → manual_review
}


@dataclass
class VerificationResult:
    route: str  # "verified" | "manual_review" | "not_verified"
    match_score: float
    liveness_score: float
    quality_overall: str
    details: dict[str, Any]
    audit: dict[str, Any]


def route_verification(
    match_score: float,
    liveness_score: float,
    quality_result: dict[str, Any],
    session_id: str,
    model_version: str = "face_v1.0.0",
) -> VerificationResult:
    """
    Определяет маршрут результата верификации.

    Логика:
        verified      — match >= 0.62 AND liveness >= 0.70 AND quality == pass
        manual_review — 0.45 <= match < 0.62 OR liveness 0.50–0.70 OR quality == warning
        not_verified  — match < 0.45 OR liveness < 0.50 OR quality == fail
    """
    quality_overall = quality_result.get("overall", "fail")

    # Определение маршрута
    if (match_score >= THRESHOLDS["match_high"]
            and liveness_score >= THRESHOLDS["liveness_pass"]
            and quality_overall == "pass"):
        route = "verified"
    elif (match_score < THRESHOLDS["match_low"]
          or liveness_score < THRESHOLDS["liveness_warning"]
          or quality_overall == "fail"):
        route = "not_verified"
    else:
        route = "manual_review"

    # Детали для аудита
    details = {
        "match_category": _categorize_match(match_score),
        "liveness_category": _categorize_liveness(liveness_score),
        "quality_category": quality_overall,
        "thresholds_used": THRESHOLDS,
        "blocking_quality_issues": quality_result.get("blocking_issues", []),
        "quality_warnings": quality_result.get("warnings", []),
    }

    audit = {
        "session_id": session_id,
        "model_version": model_version,
        "route": route,
        "match_score": match_score,
        "liveness_score": liveness_score,
        "quality_overall": quality_overall,
        "timestamp": _now_iso(),
    }

    return VerificationResult(
        route=route,
        match_score=match_score,
        liveness_score=liveness_score,
        quality_overall=quality_overall,
        details=details,
        audit=audit,
    )


def _categorize_match(score: float) -> str:
    if score >= THRESHOLDS["match_high"]:
        return "high"
    elif score >= THRESHOLDS["match_low"]:
        return "medium"
    return "low"


def _categorize_liveness(score: float) -> str:
    if score >= THRESHOLDS["liveness_pass"]:
        return "confirmed"
    elif score >= THRESHOLDS["liveness_warning"]:
        return "uncertain"
    return "failed"


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
```
# Шаблон Human Review сервиса
```python
"""
Сервис ручной проверки (Human Review) для спорных случаев верификации.
Статусы: pending → confirmed / rejected.
После закрытия — статус неизменяем.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class ReviewStatus(str, Enum):
    PENDING = "pending"
    CONFIRMED = "confirmed"
    REJECTED = "rejected"
    INFO_REQUESTED = "info_requested"  # запрошена доп. информация


class ReviewTrigger(str, Enum):
    MANUAL_REVIEW_ROUTE = "manual_review_route"
    ACUTE_DEVIATION = "acute_deviation"
    PERSISTENT_DEVIATION = "persistent_deviation"


class ReviewCreate(BaseModel):
    session_id: str
    event_id: str
    trigger_reason: ReviewTrigger
    trigger_data: dict[str, Any] = Field(default_factory=dict)
    assigned_to: str  # pseudonym медработника


class ReviewUpdate(BaseModel):
    review_id: str
    status: ReviewStatus
    reviewer_comment: str
    evidence: list[dict[str, Any]] = Field(default_factory=list)


class Review(BaseModel):
    review_id: str
    session_id: str
    event_id: str
    status: ReviewStatus
    trigger_reason: ReviewTrigger
    trigger_data: dict[str, Any]
    assigned_to: str
    created_at: str
    resolved_at: str | None = None
    reviewer_comment: str = ""
    evidence: list[dict[str, Any]] = Field(default_factory=list)
    audit: dict[str, Any] = Field(default_factory=dict)


# ─── Хранилище (в реальности — PostgreSQL) ───────────────────────

_reviews_store: dict[str, Review] = {}
_audit_chain: list[dict[str, Any]] = []


def create_review(create: ReviewCreate) -> Review:
    """Создаёт новую запись на ручную проверку."""
    review_id = f"rev_{uuid.uuid4().hex[:12]}"
    now = _now_iso()

    review = Review(
        review_id=review_id,
        session_id=create.session_id,
        event_id=create.event_id,
        status=ReviewStatus.PENDING,
        trigger_reason=create.trigger_reason,
        trigger_data=create.trigger_data,
        assigned_to=create.assigned_to,
        created_at=now,
        audit={
            "created_at": now,
            "created_by": create.assigned_to,
            "status_history": [
                {"from": None, "to": "pending", "timestamp": now}
            ],
        },
    )

    _reviews_store[review_id] = review
    _add_audit(review, "create", create.assigned_to)

    return review


def update_review(update: ReviewUpdate, reviewer_pseudonym: str) -> Review:
    """
    Обновляет статус review.
    ⚠️ После confirmed/rejected — статус неизменяем.
    """
    review = _reviews_store.get(update.review_id)
    if review is None:
        raise ValueError(f"Review {update.review_id} not found")

    # Проверка неизменяемости закрытых review
    if review.status in (ReviewStatus.CONFIRMED, ReviewStatus.REJECTED):
        raise ValueError(
            f"Review {update.review_id} is already closed "
            f"(status: {review.status}). Closed reviews are immutable."
        )

    # Проверка комментария
    if update.status in (ReviewStatus.CONFIRMED, ReviewStatus.REJECTED):
        if not update.reviewer_comment.strip():
            raise ValueError(
                "Comment is required for confirmed/rejected status"
            )

    now = _now_iso()
    previous_status = review.status
    review.status = update.status
    review.reviewer_comment = update.reviewer_comment
    review.evidence = update.evidence
    review.resolved_at = now if update.status in (
        ReviewStatus.CONFIRMED, ReviewStatus.REJECTED
    ) else None

    # Обновление аудита
    review.audit["status_history"].append({
        "from": previous_status,
        "to": update.status,
        "timestamp": now,
        "reviewer": reviewer_pseudonym,
    })

    _reviews_store[update.review_id] = review
    _add_audit(review, "update", reviewer_pseudonym, previous_status)

    return review


def get_review(review_id: str) -> Review | None:
    """Получает review по ID."""
    return _reviews_store.get(review_id)


def get_pending_reviews(assigned_to: str | None = None) -> list[Review]:
    """Получает список pending review, опционально фильтрует по медработнику."""
    pending = [
        r for r in _reviews_store.values()
        if r.status == ReviewStatus.PENDING
    ]
    if assigned_to:
        pending = [r for r in pending if r.assigned_to == assigned_to]
    return pending


def _add_audit(
    review: Review,
    action: str,
    actor: str,
    previous_status: str | None = None,
) -> None:
    """Добавляет запись в неизменяемый аудит-лог."""
    entry = {
        "id": f"aud_{uuid.uuid4().hex[:12]}",
        "timestamp": _now_iso(),
        "action": action,
        "review_id": review.review_id,
        "actor": actor,
        "previous_status": previous_status,
        "new_status": review.status,
        "immutable": True,
    }
    _audit_chain.append(entry)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
```
# Шаблон конфигурации модели (config.yaml)
```yaml
# model_configs/health_id_v1.0.0/config.yaml
# ⚠️ После публикации — файл замораживается. Изменения → новая версия.

model_version: "health_id_v1.0.0"
status: "research"
created_at: "2026-09-15"

components:
  hBody:
    weight: 0.60
    features:
      - name: "heart_rate"
        unit: "bpm"
        source: "measured"
        normal_range: [60, 90]
        required: true
        quality_thresholds:
          min_confidence: 0.8
          max_artifact_pct: 5
        formula: "normalized_score"
        contribution_weight: 0.25

      - name: "blood_pressure_systolic"
        unit: "mmHg"
        source: "measured"
        normal_range: [100, 130]
        required: true
        formula: "normalized_score"
        contribution_weight: 0.25

      - name: "blood_pressure_diastolic"
        unit: "mmHg"
        source: "measured"
        normal_range: [60, 85]
        required: true
        formula: "normalized_score"
        contribution_weight: 0.20

      - name: "temperature"
        unit: "celsius"
        source: "measured"
        normal_range: [36.1, 37.2]
        required: true
        formula: "normalized_score"
        contribution_weight: 0.15

      - name: "spo2"
        unit: "percent"
        source: "measured"
        normal_range: [95, 100]
        required: true
        formula: "normalized_score"
        contribution_weight: 0.10

      - name: "alcohol_test"
        unit: "mg/l"
        source: "measured"
        normal_range: [0, 0.15]
        required: true
        formula: "binary_penalty"
        threshold: 0.16
        contribution_weight: 0.05

  hMental:
    weight: 0.25
    features:
      - name: "adequacy_score"
        unit: "score"
        source: "measured"
        normal_range: [7, 10]
        required: true
        formula: "normalized_score"
        contribution_weight: 0.40

      - name: "speech_coherence"
        unit: "score"
        source: "derived"
        normal_range: [7, 10]
        required: false
        formula: "normalized_score"
        contribution_weight: 0.35

      - name: "pupil_reaction"
        unit: "score"
        source: "measured"
        normal_range: [7, 10]
        required: true
        formula: "normalized_score"
        contribution_weight: 0.25

  hSocial:
    weight: 0.15
    features:
      - name: "examination_regularity"
        unit: "ratio"
        source: "context"
        required: true
        formula: "normalized_score"
        normal_range: [0.8, 1.0]
        contribution_weight: 0.50

      - name: "missed_examinations"
        unit: "count"
        source: "context"
        required: true
        formula: "binary_penalty"
        threshold: 3
        contribution_weight: 0.50

thresholds:
  green: [0.80, 1.00]
  yellow: [0.60, 0.80]
  red: [0.00, 0.60]

uncertainty:
  min_completeness: 0.70
  partial_result: true

quality_rules:
  exclude_if:
    - "artifact_pct > 10"
    - "confidence < 0.7"
  flag_if:
    - "unit_mismatch"
    - "measurement_protocol_violation"
```
# Шаблон журнала версий (versions.jsonl)
```jsonl
{"version": "health_id_v1.0.0", "created_at": "2026-09-15", "status": "research", "changes": "initial release", "config_hash": "sha256:abc123def456", "parent": null}
{"version": "health_id_v1.0.1", "created_at": "2026-10-01", "status": "research", "changes": "adjusted spo2 normal range from [95,100] to [94,100]", "config_hash": "sha256:ghi789jkl012", "parent": "health_id_v1.0.0"}
{"version": "health_id_v1.1.0", "created_at": "2026-11-15", "status": "research", "changes": "added hMental.sleep_quality feature, weight redistribution in hMental", "config_hash": "sha256:mno345pqr678", "parent": "health_id_v1.0.1"}
```
# Шаблон FastAPI эндпоинтов
```python
"""
API эндпоинты для расчёта HEALTH_ID, получения результатов,
динамики состояния, human review и model card.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Depends
from pydantic import BaseModel

from app.core.engine.health_id_engine import calculate_health_id, HealthInput
from app.core.data.baseline import calculate_baseline
from app.core.review.review_service import (
    create_review, update_review, get_review, get_pending_reviews,
    ReviewCreate, ReviewUpdate, Review,
)

router = APIRouter(prefix="/api/v1", tags=["health_id"])


# ─── Расчёт HEALTH_ID ────────────────────────────────────────────

class CalculateRequest(BaseModel):
    event_id: str
    model_version: str = "health_id_v1.0.0"


class CalculateResponse(BaseModel):
    result_id: str
    status: str
    health_id: dict | None = None


@router.post("/calculate", response_model=CalculateResponse)
async def calculate(req: CalculateRequest):
    """
    Запуск расчёта HEALTH_ID для события ПрМО.
    """
    # Загрузка входных данных из БД по event_id
    input_data = await _load_event_data(req.event_id)
    if input_data is None:
        raise HTTPException(404, f"Event {req.event_id} not found")

    # Загрузка истории для baseline
    history = await _load_history(input_data.worker_pseudonym)

    # Расчёт baseline с исключением текущей точки
    baseline = calculate_baseline(
        worker_pseudonym=input_data.worker_pseudonym,
        current_event_id=req.event_id,
        history=history,
    )

    # Расчёт HEALTH_ID
    result = calculate_health_id(
        input_data=input_data,
        model_version=req.model_version,
        baseline=baseline,
        history=history,
    )

    # Сохранение результата
    await _save_result(result)

    return CalculateResponse(
        result_id=result.result_id,
        status="calculated" if result.health_id.get("value") is not None else "quality_failed",
        health_id=result.health_id,
    )


# ─── Получение результата ────────────────────────────────────────

@router.get("/results/{result_id}")
async def get_result(result_id: str):
    """Получение полного результата по ID."""
    result = await _load_result(result_id)
    if result is None:
        raise HTTPException(404, f"Result {result_id} not found")
    return result


@router.get("/results")
async def list_results(
    worker_pseudonym: str | None = None,
    model_version: str | None = None,
    category: str | None = None,
    limit: int = Query(50, le=200),
    cursor: str | None = None,
):
    """Список результатов с фильтрами и пагинацией."""
    return await _query_results(
        worker_pseudonym=worker_pseudonym,
        model_version=model_version,
        category=category,
        limit=limit,
        cursor=cursor,
    )


# ─── Динамика состояния ──────────────────────────────────────────

@router.get("/dynamics/{worker_pseudonym}")
async def get_dynamics(
    worker_pseudonym: str,
    window_days: int = Query(90, ge=7, le=365),
):
    """Динамика состояния работника за период."""
    history = await _load_history(worker_pseudonym, window_days)
    return {
        "worker_pseudonym": worker_pseudonym,
        "window_days": window_days,
        "events": history,
        "summary": _summarize_dynamics(history),
    }


# ─── Human Review ────────────────────────────────────────────────

@router.post("/review", response_model=Review)
async def create_review_endpoint(req: ReviewCreate):
    """Создание записи на ручную проверку."""
    return create_review(req)


@router.patch("/review", response_model=Review)
async def update_review_endpoint(req: ReviewUpdate, reviewer_pseudonym: str = Depends(...)):
    """Обновление статуса ручной проверки."""
    try:
        return update_review(req, reviewer_pseudonym)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/review/{review_id}", response_model=Review)
async def get_review_endpoint(review_id: str):
    """Получение статуса review по ID."""
    review = get_review(review_id)
    if review is None:
        raise HTTPException(404, f"Review {review_id} not found")
    return review


@router.get("/reviews/pending", response_model=list[Review])
async def get_pending_reviews_endpoint(
    assigned_to: str | None = None,
):
    """Список pending review."""
    return get_pending_reviews(assigned_to)


# ─── Model Card и версии ─────────────────────────────────────────

@router.get("/model-card")
async def get_current_model_card():
    """Текущая model card."""
    return await _load_model_card("latest")


@router.get("/model-card/{version}")
async def get_model_card(version: str):
    """Model card по версии."""
    card = await _load_model_card(version)
    if card is None:
        raise HTTPException(404, f"Model card {version} not found")
    return card


@router.get("/versions")
async def get_versions():
    """Журнал версий модели."""
    return await _load_versions_journal()


# ─── Заглушки для БД (заменить на реальные запросы) ──────────────

async def _load_event_data(event_id: str) -> HealthInput | None: ...
async def _load_history(worker_pseudonym: str, window_days: int = 90) -> list[dict]: ...
async def _save_result(result) -> None: ...
async def _load_result(result_id: str) -> dict | None: ...
async def _query_results(**kwargs) -> dict: ...
async def _load_model_card(version: str) -> dict | None: ...
async def _load_versions_journal() -> list[dict]: ...
def _summarize_dynamics(history: list[dict]) -> dict: ...
```
# Шаблон unit-тестов
```python
"""
Unit-тесты для движка HEALTH_ID, baseline и классификации.
Запуск: pytest tests/unit/ -v
"""
import pytest
import numpy as np
from datetime import datetime, timedelta

from app.core.engine.health_id_engine import (
    calculate_health_id, HealthInput, FeatureInput,
    normalized_score, binary_penalty,
)
from app.core.data.baseline import calculate_baseline
from app.core.classification.state_classifier import classify_state


# ─── Тесты формул ────────────────────────────────────────────────

class TestNormalizedScore:
    def test_center_of_range_returns_one(self):
        score, _ = normalized_score(75, [60, 90], "heart_rate")
        assert score == 1.0

    def test_edge_of_range_returns_half(self):
        score, _ = normalized_score(60, [60, 90], "heart_rate")
        assert abs(score - 0.5) < 0.01

    def test_outside_range_returns_low(self):
        score, _ = normalized_score(120, [60, 90], "heart_rate")
        assert score < 0.3

    def test_zero_range(self):
        score, _ = normalized_score(5, [5, 5], "const")
        assert score == 1.0


class TestBinaryPenalty:
    def test_below_threshold_returns_one(self):
        score, _ = binary_penalty(0.0, 0.16, "alcohol")
        assert score == 1.0

    def test_above_threshold_returns_zero(self):
        score, _ = binary_penalty(0.20, 0.16, "alcohol")
        assert score == 0.0

    def test_equal_threshold_returns_zero(self):
        score, _ = binary_penalty(0.16, 0.16, "alcohol")
        assert score == 0.0


# ─── Тесты baseline ──────────────────────────────────────────────

class TestBaseline:
    def _make_history(self, n_events: int, worker: str = "w1") -> list[dict]:
        base_date = datetime(2026, 1, 1)
        return [
            {
                "event_id": f"evt_{i}",
                "worker_pseudonym": worker,
                "timestamp": (base_date + timedelta(days=i*7)).isoformat(),
                "quality_status": "pass",
                "measurements": {
                    "heart_rate": 70 + i * 2,
                    "blood_pressure_systolic": 120 + i,
                },
            }
            for i in range(n_events)
        ]

    def test_baseline_excludes_current_event(self):
        """⚠️ Критический тест: текущая точка не входит в baseline."""
        history = self._make_history(10)
        current_event_id = "evt_5"

        baseline = calculate_baseline(
            worker_pseudonym="w1",
            current_event_id=current_event_id,
            history=history,
        )

        assert baseline["available"] is True
        assert baseline["excluded_event"] == current_event_id

        # Проверка: значение из текущего события не влияет на baseline
        current_hr = 70 + 5 * 2  # = 80
        baseline_mean = baseline["features"]["heart_rate"]["mean"]
        # Без исключения mean было бы другим
        all_values = [70 + i * 2 for i in range(10) if i != 5]
        expected_mean = np.mean(all_values)
        assert abs(baseline_mean - expected_mean) < 0.01

    def test_baseline_insufficient_history(self):
        history = self._make_history(2)
        baseline = calculate_baseline("w1", "evt_0", history)
        assert baseline["available"] is False
        assert baseline["reason"] == "insufficient_history"

    def test_baseline_min_points_per_feature(self):
        history = self._make_history(5)
        # Удаляем heart_rate из двух событий
        for h in history[:2]:
            del h["measurements"]["heart_rate"]

        baseline = calculate_baseline("w1", "evt_4", history)
        assert baseline["features"]["heart_rate"]["available"] is False
        assert baseline["features"]["heart_rate"]["reason"] == "insufficient_points"


# ─── Тесты классификации ─────────────────────────────────────────

class TestStateClassification:
    def test_acute_deviation_detected(self):
        validated = HealthInput(
            event_id="evt_1",
            worker_pseudonym="w1",
            timestamp="2026-09-15T10:00:00+04:00",
            measurements=[
                FeatureInput(name="heart_rate", value=120, unit="bpm",
                            source="measured", confidence=0.95,
                            artifact_pct=1, timestamp="2026-09-15T10:00:00+04:00"),
            ],
        )
        baseline = {
            "available": True,
            "features": {
                "heart_rate": {
                    "available": True,
                    "mean": 72, "std": 5,
                    "corridor_low": 62, "corridor_high": 82,
                }
            },
        }
        config = {"components": {}}

        flags = classify_state(validated, config, baseline, history=None)

        acute = next(f for f in flags if f["flag"] == "acute_deviation")
        assert acute["active"] is True
        assert acute["feature"] == "heart_rate"

    def test_persistent_deviation_counts_unique_dates(self):
        """⚠️ Критический тест: повторные отклонения считаются по уникальным датам."""
        # 3 попытки в один день — не должны считаться как 3 отклонения
        history = [
            {
                "has_acute_deviation": True,
                "timestamp": "2026-09-15T08:00:00+04:00",
            },
            {
                "has_acute_deviation": True,
                "timestamp": "2026-09-15T10:00:00+04:00",
            },
            {
                "has_acute_deviation": True,
                "timestamp": "2026-09-15T12:00:00+04:00",
            },
        ]

        validated = HealthInput(
            event_id="evt_new",
            worker_pseudonym="w1",
            timestamp="2026-09-20T10:00:00+04:00",
            measurements=[],
        )

        flags = classify_state(validated, {"components": {}}, None, history)

        persistent = next(f for f in flags if f["flag"] == "persistent_repeated_deviation")
        assert persistent["active"] is False
        assert persistent["date_count"] == 1  # одна дата, не три

    def test_persistent_deviation_triggered(self):
        history = [
            {"has_acute_deviation": True, "timestamp": "2026-09-10T10:00:00+04:00"},
            {"has_acute_deviation": True, "timestamp": "2026-09-12T10:00:00+04:00"},
            {"has_acute_deviation": True, "timestamp": "2026-09-15T10:00:00+04:00"},
        ]
        validated = HealthInput(
            event_id="evt_new",
            worker_pseudonym="w1",
            timestamp="2026-09-20T10:00:00+04:00",
            measurements=[],
        )
        flags = classify_state(validated, {"components": {}}, None, history)
        persistent = next(f for f in flags if f["flag"] == "persistent_repeated_deviation")
        assert persistent["active"] is True
        assert persistent["date_count"] == 3


# ─── Тесты воспроизводимости ─────────────────────────────────────

class TestReproducibility:
    def test_same_input_same_output(self):
        """Тот же вход + та же версия → идентичный результат."""
        input_data = HealthInput(
            event_id="evt_repro",
            worker_pseudonym="w_repro",
            timestamp="2026-09-15T10:00:00+04:00",
            measurements=[
                FeatureInput(name="heart_rate", value=72, unit="bpm",
                            source="measured", confidence=0.95,
                            artifact_pct=1, timestamp="2026-09-15T10:00:00+04:00"),
                FeatureInput(name="blood_pressure_systolic", value=120, unit="mmHg",
                            source="measured", confidence=0.90,
                            artifact_pct=2, timestamp="2026-09-15T10:00:00+04:00"),
                FeatureInput(name="blood_pressure_diastolic", value=78, unit="mmHg",
                            source="measured", confidence=0.90,
                            artifact_pct=2, timestamp="2026-09-15T10:00:00+04:00"),
                FeatureInput(name="temperature", value=36.6, unit="celsius",
                            source="measured", confidence=0.95,
                            artifact_pct=0, timestamp="2026-09-15T10:00:00+04:00"),
                FeatureInput(name="spo2", value=98, unit="percent",
                            source="measured", confidence=0.95,
                            artifact_pct=0, timestamp="2026-09-15T10:00:00+04:00"),
                FeatureInput(name="alcohol_test", value=0.0, unit="mg/l",
                            source="measured", confidence=1.0,
                            artifact_pct=0, timestamp="2026-09-15T10:00:00+04:00"),
                FeatureInput(name="adequacy_score", value=8, unit="score",
                            source="measured", confidence=0.90,
                            artifact_pct=0, timestamp="2026-09-15T10:00:00+04:00"),
                FeatureInput(name="pupil_reaction", value=9, unit="score",
                            source="measured", confidence=0.90,
                            artifact_pct=0, timestamp="2026-09-15T10:00:00+04:00"),
                FeatureInput(name="examination_regularity", value=0.95, unit="ratio",
                            source="context", confidence=1.0,
                            artifact_pct=0, timestamp="2026-09-15T10:00:00+04:00"),
                FeatureInput(name="missed_examinations", value=0, unit="count",
                            source="context", confidence=1.0,
                            artifact_pct=0, timestamp="2026-09-15T10:00:00+04:00"),
            ],
        )

        result1 = calculate_health_id(input_data, "health_id_v1.0.0")
        result2 = calculate_health_id(input_data, "health_id_v1.0.0")

        assert result1.health_id["value"] == result2.health_id["value"]
        assert result1.audit["config_snapshot_hash"] == result2.audit["config_snapshot_hash"]

    def test_result_contains_disclaimer(self):
        input_data = HealthInput(
            event_id="evt_disc",
            worker_pseudonym="w_disc",
            timestamp="2026-09-15T10:00:00+04:00",
            measurements=[],
        )
        result = calculate_health_id(input_data, "health_id_v1.0.0")
        assert "Не является медицинским диагнозом" in result.health_id.get("disclaimer", "")
```