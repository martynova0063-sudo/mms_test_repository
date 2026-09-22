"""
app/schemas/health_result.py

Pydantic-модели для входных и выходных данных API.
"""

from pydantic import BaseModel, Field
from typing import Optional, Any


# ---------------------------------------------------------------------------
# Входные схемы
# ---------------------------------------------------------------------------

class VitalInput(BaseModel):
    name: str
    value: float
    unit: str
    source: str = "measured"
    confidence: Optional[float] = None
    artifact_pct: Optional[float] = None
    measurement_protocol: Optional[str] = None
    device_id: Optional[str] = None
    device_model: Optional[str] = None
    timestamp: Optional[str] = None


class MentalInput(BaseModel):
    name: str
    value: float
    confidence: Optional[float] = None
    source: str = "measured"
    timestamp: Optional[str] = None


class ContextInput(BaseModel):
    workplace: Optional[str] = None
    shift: Optional[str] = None
    examination_type: str = "periodic"
    examination_regularity: Optional[float] = None
    missed_examinations: Optional[int] = None


class MeasurementsInput(BaseModel):
    vitals: list[VitalInput] = []
    mental: list[MentalInput] = []
    context: Optional[ContextInput] = None


class MetadataInput(BaseModel):
    mis_source: str = "ECOZ"
    transmission_id: Optional[str] = None
    transmission_timestamp: Optional[str] = None


class CalculateRequest(BaseModel):
    """
    Полный входной пакет ПрМО.

    Если event_id уже существует в БД — будет выполнен только расчёт
    (без повторного приёма данных).
    """
    event_id: str = Field(..., description="Уникальный идентификатор события")
    event_type: str = "periodic_medical_examination"
    worker_pseudonym: str = Field(..., description="hash(SNP_ID)")
    timestamp: str = Field(..., description="ISO-8601")
    measurements: MeasurementsInput
    metadata: Optional[MetadataInput] = None


class CalculateByIdRequest(BaseModel):
    """
    Упрощённый запрос — расчёт для уже принятого события.
    """
    event_id: str = Field(..., description="event_id уже принятого события")
    model_version: Optional[str] = Field(None, description="Версия модели")


# ---------------------------------------------------------------------------
# Выходные схемы (выходной контракт — раздел 9.1)
# ---------------------------------------------------------------------------

class ComponentResult(BaseModel):
    name: str
    value: float
    weight: float
    contribution: float
    available_features: int
    total_features: int
    features: list[dict]


class StateFlagOutput(BaseModel):
    flag: str
    active: bool
    feature: Optional[str] = None
    value: Optional[float] = None
    corridor: Optional[list[float]] = None
    deviation_type: Optional[str] = None
    sigma: Optional[float] = None
    severity: Optional[str] = None
    evidence: Optional[list[str]] = None


class EvidenceOutput(BaseModel):
    input_ids: list[str]
    quality_reports: Optional[dict] = None
    formulas_applied: list[str] = []
    contribution_trace: dict = {}
    model_card_ref: str
    config_hash: str
    state_flags: list[dict] = []
    classification_summary: Optional[str] = None
    baseline: Optional[dict] = None


class CalculateResponse(BaseModel):
    result_id: str
    event_id: str
    health_id: dict                          # {value, category}
    components: dict[str, ComponentResult]  # {hBody, hMental, hSocial}
    completeness: float
    uncertainty: float
    missing_features: Optional[list[str]] = None
    state_flags: list[StateFlagOutput] = []
    dominant_flag: Optional[str] = None
    evidence: EvidenceOutput
    human_readable: str
    disclaimer: str
    model_version: str
    config_snapshot_hash: str
    quality_status: str
    calculation_duration_ms: Optional[int] = None
    reproducible: bool = True
