"""
app/api/routes/calculate.py

Единый пайплайн: приём данных → HEALTH_ID → baseline → классификация → контракт.

POST /api/v1/calculate   — полный цикл (приём + расчёт)
POST /api/v1/calculate/by-id — расчёт для уже принятого события
GET  /api/v1/results/{result_id} — получение результата по ID
GET  /api/v1/results — список результатов
GET  /api/v1/dynamics/{worker_pseudonym} — динамика работника
"""

from __future__ import annotations
import time
import uuid
from typing import Optional
import numpy as np

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, desc
from sqlalchemy.orm import Session

from app.db.session import get_session
from app.db.models import (
    ExaminationEvent,
    HealthIdResult,
    VitalMeasurement,
    SocialContext,
)
from app.schemas.health_result import (
    CalculateRequest,
    CalculateByIdRequest,
    CalculateResponse,
)
from app.core.data.intake import intake_event
from app.core.engine.health_id_engine import calculate_health_id
from app.core.data.baseline import calculate_baseline, check_all_deviations
from app.core.classification.state_classifier import (
    classify_state,
    apply_classification_to_result,
)
from app.core.explainability.output_contract import build_output_contract
from app.config import settings
from app.core.review.review_service import auto_create_review_for_health_id

router = APIRouter(prefix="/api/v1", tags=["HEALTH_ID"])


def _to_native(obj):
    """Рекурсивно конвертирует numpy-типы в нативные Python-типы."""
    
    if isinstance(obj, dict):
        return {k: _to_native(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [_to_native(v) for v in obj]
    elif isinstance(obj, np.bool_):
        return bool(obj)
    elif isinstance(obj, np.integer):
        return int(obj)
    elif isinstance(obj, np.floating):
        return float(obj)
    elif isinstance(obj, np.ndarray):
        return _to_native(obj.tolist())
    return obj

# ---------------------------------------------------------------------------
# POST /api/v1/calculate — полный пайплайн
# ---------------------------------------------------------------------------

@router.post("/calculate", response_model=CalculateResponse)
def full_pipeline(
    request: CalculateRequest,
    session: Session = Depends(get_session),
):
    """
    Единый пайплайн:

    1. Приём входных данных (Модуль 3)
    2. Контроль качества (чек-лист 6.2)
    3. Расчёт HEALTH_ID (Модуль 2)
    4. Расчёт персональных коридоров (Модуль 4)
    5. Проверка отклонений от коридоров
    6. Классификация состояния (Модуль 5)
    7. Формирование выходного контракта (Модуль 6)
    """
    pipeline_start = time.time()

    # --- Преобразование Pydantic → dict для intake ---
    payload = request.model_dump()
    # Pydantic возвращает enum-подобные значения; нормализуем
    payload["measurements"]["vitals"] = [
        {**v, "timestamp": v.get("timestamp") or payload["timestamp"]}
        for v in payload["measurements"]["vitals"]
    ]

    # --- 1. Приём данных (Модуль 3) ---
    try:
        event = intake_event(payload, session)
    except ValueError as e:
        if "Дубликат" in str(e):
            # Событие уже принято — пропускаем к расчёту
            event = session.execute(
                select(ExaminationEvent).where(
                    ExaminationEvent.event_id == request.event_id
                )
            ).scalar_one_or_none()
            if event is None:
                raise HTTPException(500, "Дубликат event_id, но запись не найдена")
        else:
            raise HTTPException(422, f"Ошибка приёма данных: {e}")

    # Проверка качества
    if event.quality_status == "fail":
        raise HTTPException(
            422,
            f"Пакет провалил контроль качества: {event.quality_report}"
        )

    # --- Заполнение social, если context есть в payload ---
    if payload.get("measurements", {}).get("context"):
        ctx = payload["measurements"]["context"]
        social = session.execute(
            select(SocialContext).where(SocialContext.event_id == event.id)
        ).scalar_one_or_none()
        if social:
            if ctx.get("examination_regularity") is not None:
                social.examination_regularity = float(ctx["examination_regularity"])
            if ctx.get("missed_examinations") is not None:
                social.missed_examinations = int(ctx["missed_examinations"])
            session.commit()

    # --- 2-7. Расчёт HEALTH_ID + baseline + классификация ---
    try:
        result = _run_calculation_pipeline(session, event)
    except ValueError as e:
        raise HTTPException(409, str(e))

    # --- Сборка выходного контракта ---
    # Перечитываем result с загруженными связями
    result = session.execute(
        select(HealthIdResult).where(HealthIdResult.id == result.id)
    ).scalar_one()
    # Загружаем event для контракта
    event_fresh = session.execute(
        select(ExaminationEvent).where(ExaminationEvent.id == result.event_id)
    ).scalar_one()

    # Получаем компоненты для контракта (повторный расчёт не нужен — берём из БД)
    components_data = _assemble_components_from_db(result)

    # Baseline для evidence
    baseline = calculate_baseline(
        session=session,
        worker_pseudonym=event_fresh.worker_pseudonym,
        current_event_id=event_fresh.event_id,
        window_days=settings.DEFAULT_WINDOW_DAYS,
    )

    # Классификация из БД
    from app.core.classification.rules import (
        ClassificationResult, StateFlag,
    )
    classification = _reconstruct_classification(result)

    contract = build_output_contract(result, components_data, classification, baseline)

    pipeline_ms = int((time.time() - pipeline_start) * 1000)
    contract["calculation_duration_ms"] = pipeline_ms

    contract = _to_native(contract)  # ← добавить эту строку

    return contract


# ---------------------------------------------------------------------------
# POST /api/v1/calculate/by-id — расчёт для существующего события
# ---------------------------------------------------------------------------

@router.post("/calculate/by-id", response_model=CalculateResponse)
def calculate_by_id(
    request: CalculateByIdRequest,
    session: Session = Depends(get_session),
):
    """
    Расчёт HEALTH_ID для события, уже принятого в БД.
    """
    event = session.execute(
        select(ExaminationEvent).where(
            ExaminationEvent.event_id == request.event_id
        )
    ).scalar_one_or_none()

    if event is None:
        raise HTTPException(404, f"Событие не найдено: {request.event_id}")

    if event.quality_status == "fail":
        raise HTTPException(422, "Событие провалило контроль качества")

    try:
        result = _run_calculation_pipeline(session, event)
    except ValueError as e:
        raise HTTPException(409, str(e))

    # Сборка контракта
    result = session.execute(
        select(HealthIdResult).where(HealthIdResult.id == result.id)
    ).scalar_one()
    event_fresh = session.execute(
        select(ExaminationEvent).where(ExaminationEvent.id == result.event_id)
    ).scalar_one()

    components_data = _assemble_components_from_db(result)
    baseline = calculate_baseline(
        session=session,
        worker_pseudonym=event_fresh.worker_pseudonym,
        current_event_id=event_fresh.event_id,
        window_days=settings.DEFAULT_WINDOW_DAYS,
    )
    classification = _reconstruct_classification(result)
    contract = build_output_contract(result, components_data, classification, baseline)

    return contract


# ---------------------------------------------------------------------------
# GET /api/v1/results/{result_id}
# ---------------------------------------------------------------------------

@router.get("/results/{result_id}")
def get_result(
    result_id: str,
    session: Session = Depends(get_session),
):
    """Получение результата по ID."""
    result = session.execute(
        select(HealthIdResult).where(HealthIdResult.id == result_id)
    ).scalar_one_or_none()

    if result is None:
        raise HTTPException(404, f"Результат не найден: {result_id}")

    event = session.execute(
        select(ExaminationEvent).where(ExaminationEvent.id == result.event_id)
    ).scalar_one()

    components_data = _assemble_components_from_db(result)
    baseline = calculate_baseline(
        session=session,
        worker_pseudonym=event.worker_pseudonym,
        current_event_id=event.event_id,
        window_days=settings.DEFAULT_WINDOW_DAYS,
    )
    classification = _reconstruct_classification(result)
    contract = build_output_contract(result, components_data, classification, baseline)

    return contract


# ---------------------------------------------------------------------------
# GET /api/v1/results — список с пагинацией
# ---------------------------------------------------------------------------

@router.get("/results")
def list_results(
    worker_pseudonym: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    limit: int = Query(50, le=200),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_session),
):
    """Список результатов с фильтрами."""
    stmt = select(HealthIdResult).order_by(desc(HealthIdResult.calculated_at))

    if worker_pseudonym:
        stmt = stmt.join(ExaminationEvent).where(
            ExaminationEvent.worker_pseudonym == worker_pseudonym
        )
    if category:
        stmt = stmt.where(HealthIdResult.category == category)

    stmt = stmt.offset(offset).limit(limit)
    results = session.execute(stmt).scalars().all()

    return {
        "count": len(results),
        "items": [
            {
                "result_id": r.id,
                "event_id": r.event_id,
                "value": r.value,
                "category": r.category,
                "model_version": r.model_version,
                "calculated_at": r.calculated_at.isoformat() if r.calculated_at else None,
            }
            for r in results
        ],
    }


# ---------------------------------------------------------------------------
# GET /api/v1/dynamics/{worker_pseudonym}
# ---------------------------------------------------------------------------

@router.get("/dynamics/{worker_pseudonym}")
def get_dynamics(
    worker_pseudonym: str,
    limit: int = Query(50, le=200),
    session: Session = Depends(get_session),
):
    """Динамика состояния работника."""
    events = session.execute(
        select(ExaminationEvent)
        .where(ExaminationEvent.worker_pseudonym == worker_pseudonym)
        .order_by(ExaminationEvent.timestamp.asc())
        .limit(limit)
    ).scalars().all()

    dynamics = []
    for event in events:
        result = session.execute(
            select(HealthIdResult).where(HealthIdResult.event_id == event.id)
        ).scalar_one_or_none()

        dynamics.append({
            "event_id": event.event_id,
            "timestamp": event.timestamp.isoformat() if event.timestamp else None,
            "quality_status": event.quality_status,
            "health_id": result.value if result else None,
            "category": result.category if result else None,
            "acute_deviation": bool(result.acute_deviation) if result else False,
            "persistent_repeated_deviation": bool(result.persistent_repeated_deviation) if result else False,
            "confirmed_chronic": bool(result.confirmed_chronic) if result else False,
        })

    return {
        "worker_pseudonym": worker_pseudonym,
        "count": len(dynamics),
        "dynamics": dynamics,
    }


# ---------------------------------------------------------------------------
# Вспомогательные функции
# ---------------------------------------------------------------------------

def _to_native(obj):
    """Рекурсивно конвертирует numpy-типы в нативные Python-типы."""

    if isinstance(obj, dict):
        return {k: _to_native(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [_to_native(v) for v in obj]
    elif isinstance(obj, np.bool_):
        return bool(obj)
    elif isinstance(obj, np.integer):
        return int(obj)
    elif isinstance(obj, np.floating):
        return float(obj)
    return obj


def _sanitize_result(result):
    """Конвертирует numpy-типы во всех полях HealthIdResult в нативные Python-типы."""
    import numpy as np
    import dataclasses
    import logging

    logger = logging.getLogger(__name__)

    def _to_native(value):
        if isinstance(value, dict):
            return {k: _to_native(v) for k, v in value.items()}
        elif isinstance(value, (list, tuple)):
            return [_to_native(v) for v in value]
        elif isinstance(value, np.bool_):
            return bool(value)
        elif isinstance(value, np.integer):
            return int(value)
        elif isinstance(value, np.floating):
            return float(value)
        elif hasattr(value, 'item') and not isinstance(value, (str, bytes)):
            # Любой другой numpy-скаляр
            try:
                return value.item()
            except Exception:
                return value
        return value

    # Проходим по всем полям объекта
    if dataclasses.is_dataclass(result):
        fields = dataclasses.fields(result)
        for f in fields:
            val = getattr(result, f.name, None)
            setattr(result, f.name, _to_native(val))
    else:
        # Если это не dataclass, пробуем через __dict__ или __table__.columns
        if hasattr(result, '__dict__'):
            for key, val in vars(result).items():
                setattr(result, key, _to_native(val))
        elif hasattr(result, '__table__'):
            for col in result.__table__.columns:
                val = getattr(result, col.name, None)
                setattr(result, col.name, _to_native(val))

    return result

def _run_calculation_pipeline(session: Session, event: ExaminationEvent) -> HealthIdResult:
    """
    Внутренний пайплайн расчёта:
    1. HEALTH_ID
    2. Baseline + отклонения
    3. Классификация
    4. Запись флагов в результат
    """
    
 # --- 1. Расчёт HEALTH_ID ---
    result = calculate_health_id(event.event_id, session)

    # --- 2. Baseline ---
    baseline = calculate_baseline(
        session=session,
        worker_pseudonym=event.worker_pseudonym,
        current_event_id=event.event_id,
        window_days=settings.DEFAULT_WINDOW_DAYS,
    )

    deviations = check_all_deviations(session, baseline, event.event_id)

    # --- 3. Классификация ---
    classification = classify_state(
        session=session,
        health_id_result=result,
        baseline=baseline,
        current_deviations=deviations,
        worker_pseudonym=event.worker_pseudonym,
        current_event_id=event.event_id,
    )

    # --- 4. Запись флагов ---
    result = apply_classification_to_result(session, result, classification)
    
    # --- 5. Автоматическое создание review при красной зоне / chronic ---
    review = auto_create_review_for_health_id(session, result)
    if review:
        result.human_readable += (f"\n\n⚠️ Создан human review ({review.id}) — требуется проверка медработником.")
    session.commit()

    # --- Дополнение human-readable ---
    result.human_readable += "\n\n" + classification.summary
    session.commit()

    # --- 6. Конвертация numpy-типов перед возвратом ---
    result = _sanitize_result(result)
    session.commit()

    return result


def _assemble_components_from_db(result: HealthIdResult) -> list:
    """
    Собирает объекты ComponentResult из записи БД
    (для передачи в build_output_contract).
    """
    from app.core.engine.health_id_engine import ComponentResult, FeatureResult

    components = []

    # hBody
    hbody = ComponentResult("hBody", result.hbody_weight)
    hbody.score = result.hbody_value
    hbody.contribution = result.hbody_contribution
    hbody.available_count = 6  # упрощённо — из evidence
    hbody.total_count = 6
    components.append(hbody)

    # hMental
    hmental = ComponentResult("hMental", result.hmental_weight)
    hmental.score = result.hmental_value
    hmental.contribution = result.hmental_contribution
    hmental.available_count = 3
    hmental.total_count = 3
    components.append(hmental)

    # hSocial
    hsocial = ComponentResult("hSocial", result.hsocial_weight)
    hsocial.score = result.hsocial_value
    hsocial.contribution = result.hsocial_contribution
    hsocial.available_count = 2
    hsocial.total_count = 2
    components.append(hsocial)

    return components


def _reconstruct_classification(result: HealthIdResult) -> ClassificationResult:
    """
    Восстанавливает ClassificationResult из флагов в БД.
    """
    from app.core.classification.rules import (
        ClassificationResult, StateFlag, get_dominant_flag,
    )

    flags = []

    flags.append(StateFlag(
        flag="acute_deviation",
        active=result.acute_deviation,
    ))
    flags.append(StateFlag(
        flag="persistent_repeated_deviation",
        active=result.persistent_repeated_deviation,
    ))
    flags.append(StateFlag(
        flag="confirmed_chronic",
        active=result.confirmed_chronic,
    ))

    personal = StateFlag(
        flag="personal_deviation",
        active=result.personal_deviation,
    )
    if result.personal_deviation:
        personal.feature = result.personal_deviation_feature
        if result.personal_deviation_detail:
            personal.value = result.personal_deviation_detail.get("value")
            personal.corridor = result.personal_deviation_detail.get("corridor")
            personal.deviation_type = result.personal_deviation_detail.get("deviation_type")
            personal.sigma = result.personal_deviation_detail.get("sigma")
            personal.severity = result.personal_deviation_detail.get("severity")
    flags.append(personal)

    # Восстановление evidence из БД
    if result.evidence and "state_flags" in result.evidence:
        for i, sf in enumerate(result.evidence["state_flags"]):
            if i < len(flags):
                flags[i].evidence = sf.get("evidence", [])

    dominant = get_dominant_flag(flags)

    summary = ""
    if result.evidence and "classification_summary" in result.evidence:
        summary = result.evidence["classification_summary"]

    return ClassificationResult(
        health_id_value=result.value,
        health_id_category=result.category,
        flags=flags,
        dominant_flag=dominant,
        summary=summary,
    )
