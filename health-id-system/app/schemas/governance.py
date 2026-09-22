"""
app/schemas/governance.py

Pydantic-модели для Model Governance API.
"""

from pydantic import BaseModel, Field
from typing import Optional, Any
from datetime import datetime


class ModelVersionOutput(BaseModel):
    id: str
    status: str
    config_hash: str
    description: Optional[str] = None
    created_at: datetime
    published_at: Optional[datetime] = None
    deprecated_at: Optional[datetime] = None
    validation_status: Optional[str] = None
    validation_metrics: Optional[dict] = None


class CreateVersionRequest(BaseModel):
    version_id: str = Field(..., description="Напр. health_id_v1.1.0")
    config_yaml: str = Field(..., description="YAML-конфиг")
    description: Optional[str] = None


class DriftRecordOutput(BaseModel):
    id: str
    model_version_id: str
    drift_type: str
    feature_name: Optional[str] = None
    detected_at: datetime
    severity: str
    description: Optional[str] = None
    p_value: Optional[float] = None
    test_name: Optional[str] = None
    reference_mean: Optional[float] = None
    current_mean: Optional[float] = None
    recommended_action: Optional[str] = None
    resolved: bool


class ValidationReportOutput(BaseModel):
    id: str
    stage: str
    model_version_id: str
    status: str
    started_at: datetime
    completed_at: Optional[datetime] = None
    metrics: Optional[dict] = None
    summary: Optional[str] = None
    n_samples: Optional[int] = None
    n_workers: Optional[int] = None
    reproducibility_score: Optional[float] = None
