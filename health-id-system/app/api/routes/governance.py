"""
app/api/routes/governance.py

Модуль 8: API для Model Governance.

Эндпоинты:
  GET    /api/v1/governance/versions           — список версий
  GET    /api/v1/governance/versions/{id}       — версия по ID
  GET    /api/v1/governance/versions/active     — активная версия
  POST   /api/v1/governance/versions            — создать версию
  POST   /api/v1/governance/versions/{id}/publish — опубликовать
  POST   /api/v1/governance/versions/{id}/deprecate — депрекировать

  POST   /api/v1/governance/drift/detect        — запустить детекцию дрейфа
  GET    /api/v1/governance/drift               — список записей дрейфа
  POST   /api/v1/governance/drift/{id}/resolve  — разрешить дрейф

  POST   /api/v1/governance/validation/r0       — запустить R0
  POST   /api/v1/governance/validation/r1       — запустить R1
  GET    /api/v1/governance/validation           — список отчётов
  GET    /api/v1/governance/validation/{id}     — отчёт по ID
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from typing import Optional

from app.db.session import get_session
from app.schemas.governance import (
    ModelVersionOutput,
    CreateVersionRequest,
    DriftRecordOutput,
    ValidationReportOutput,
)
from app.core.governance.version_service import (
    create_version,
    publish_version,
    deprecate_version,
    get_version,
    get_active_version,
    list_versions,
    init_default_version,
)
from app.core.governance.drift_detector import (
    detect_drift,
    list_drift_records,
    resolve_drift,
)
from app.core.governance.validation_service import (
    run_r0_validation,
    run_r1_validation,
    list_validation_reports,
    get_validation_report,
)


router = APIRouter(prefix="/api/v1/governance", tags=["Model Governance"])


# ---------------------------------------------------------------------------
# Версии модели
# ---------------------------------------------------------------------------

@router.get("/versions", response_model=list[ModelVersionOutput])
def versions_list(session: Session = Depends(get_session)):
    """Список всех версий модели."""
    versions = list_versions(session)
    return [_version_to_output(v) for v in versions]


@router.get("/versions/active", response_model=ModelVersionOutput | None)
def active_version(session: Session = Depends(get_session)):
    """Активная (published) версия."""
    v = get_active_version(session)
    return _version_to_output(v) if v else None


@router.get("/versions/{version_id}", response_model=ModelVersionOutput)
def version_get(version_id: str, session: Session = Depends(get_session)):
    """Получить версию по ID."""
    try:
        v = get_version(session, version_id)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return _version_to_output(v)


@router.post("/versions", response_model=ModelVersionOutput)
def version_create(
    request: CreateVersionRequest,
    session: Session = Depends(get_session),
):
    """Создать новую версию (draft)."""
    try:
        v = create_version(
            session=session,
            version_id=request.version_id,
            config_yaml_text=request.config_yaml,
            description=request.description,
        )
    except ValueError as e:
        raise HTTPException(409, str(e))
    return _version_to_output(v)


@router.post("/versions/{version_id}/publish", response_model=ModelVersionOutput)
def version_publish(version_id: str, session: Session = Depends(get_session)):
    """Опубликовать версию."""
    try:
        v = publish_version(session, version_id)
    except ValueError as e:
        raise HTTPException(409, str(e))
    return _version_to_output(v)


@router.post("/versions/{version_id}/deprecate", response_model=ModelVersionOutput)
def version_deprecate(
    version_id: str,
    reason: str = Query(..., description="Причина депрекации"),
    session: Session = Depends(get_session),
):
    """Депрекировать версию."""
    try:
        v = deprecate_version(session, version_id, reason)
    except ValueError as e:
        raise HTTPException(409, str(e))
    return _version_to_output(v)


# ---------------------------------------------------------------------------
# Дрейф
# ---------------------------------------------------------------------------

@router.post("/drift/detect", response_model=list[DriftRecordOutput])
def drift_detect(
    model_version_id: str = Query(..., description="ID версии модели"),
    reference_days: int = Query(30, ge=1, le=365),
    current_days: int = Query(7, ge=1, le=90),
    session: Session = Depends(get_session),
):
    """Запустить детекцию дрейфа."""
    records = detect_drift(
        session=session,
        model_version_id=model_version_id,
        reference_days=reference_days,
        current_days=current_days,
    )
    return [_drift_to_output(r) for r in records]


@router.get("/drift", response_model=list[DriftRecordOutput])
def drift_list(
    model_version_id: Optional[str] = Query(None),
    drift_type: Optional[str] = Query(None),
    resolved: Optional[bool] = Query(None),
    limit: int = Query(50, le=200),
    session: Session = Depends(get_session),
):
    """Список записей дрейфа."""
    records = list_drift_records(
        session=session,
        model_version_id=model_version_id,
        drift_type=drift_type,
        resolved=resolved,
        limit=limit,
    )
    return [_drift_to_output(r) for r in records]


@router.post("/drift/{drift_id}/resolve", response_model=DriftRecordOutput)
def drift_resolve(
    drift_id: str,
    resolved_by: str = Query("system"),
    session: Session = Depends(get_session),
):
    """Отметить дрейф как разрешённый."""
    try:
        r = resolve_drift(session, drift_id, resolved_by)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return _drift_to_output(r)


# ---------------------------------------------------------------------------
# Валидация
# ---------------------------------------------------------------------------

@router.post("/validation/r0", response_model=ValidationReportOutput)
def validation_r0(
    model_version_id: str = Query(...),
    session: Session = Depends(get_session),
):
    """R0: Аналитическая валидация (воспроизводимость)."""
    report = run_r0_validation(session, model_version_id)
    return _report_to_output(report)


@router.post("/validation/r1", response_model=ValidationReportOutput)
def validation_r1(
    model_version_id: str = Query(...),
    session: Session = Depends(get_session),
):
    """R1: Ретроспективная валидация (метрики на пилоте)."""
    report = run_r1_validation(session, model_version_id)
    return _report_to_output(report)


@router.get("/validation", response_model=list[ValidationReportOutput])
def validation_list(
    stage: Optional[str] = Query(None),
    model_version_id: Optional[str] = Query(None),
    session: Session = Depends(get_session),
):
    """Список отчётов валидации."""
    reports = list_validation_reports(
        session=session,
        stage=stage,
        model_version_id=model_version_id,
    )
    return [_report_to_output(r) for r in reports]


@router.get("/validation/{report_id}", response_model=ValidationReportOutput)
def validation_get(report_id: str, session: Session = Depends(get_session)):
    """Получить отчёт по ID."""
    try:
        r = get_validation_report(session, report_id)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return _report_to_output(r)


# ---------------------------------------------------------------------------
# Вспомогательные функции
# ---------------------------------------------------------------------------

def _version_to_output(v) -> ModelVersionOutput:
    return ModelVersionOutput(
        id=v.id,
        status=v.status,
        config_hash=v.config_hash,
        description=v.description,
        created_at=v.created_at,
        published_at=v.published_at,
        deprecated_at=v.deprecated_at,
        validation_status=v.validation_status,
        validation_metrics=v.validation_metrics,
    )


def _drift_to_output(r) -> DriftRecordOutput:
    return DriftRecordOutput(
        id=r.id,
        model_version_id=r.model_version_id,
        drift_type=r.drift_type,
        feature_name=r.feature_name,
        detected_at=r.detected_at,
        severity=r.severity,
        description=r.description,
        p_value=r.p_value,
        test_name=r.test_name,
        reference_mean=r.reference_mean,
        current_mean=r.current_mean,
        recommended_action=r.recommended_action,
        resolved=r.resolved,
    )


def _report_to_output(r) -> ValidationReportOutput:
    return ValidationReportOutput(
        id=r.id,
        stage=r.stage,
        model_version_id=r.model_version_id,
        status=r.status,
        started_at=r.started_at,
        completed_at=r.completed_at,
        metrics=r.metrics,
        summary=r.summary,
        n_samples=r.n_samples,
        n_workers=r.n_workers,
        reproducibility_score=r.reproducibility_score,
    )
