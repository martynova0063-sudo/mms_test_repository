"""
app/schemas/review.py

Pydantic-модели для Human Review API.
"""

from pydantic import BaseModel, Field
from typing import Optional, Any
from datetime import datetime


# ---------------------------------------------------------------------------
# Запросы
# ---------------------------------------------------------------------------

class CreateReviewRequest(BaseModel):
    """Создание review (автоматически системой или вручную)."""
    review_type: str = Field(..., description="verification | health_id | classification")
    target_id: str = Field(..., description="ID проверяемой записи")
    event_id: Optional[str] = None
    worker_pseudonym: Optional[str] = None
    assigned_reason: Optional[str] = None
    priority: str = "normal"
    context: Optional[dict] = None


class ReviewDecisionRequest(BaseModel):
    """Решение медработника по review."""
    decision: str = Field(..., description="confirmed | rejected | escalated")
    comment: Optional[str] = Field(None, description="Комментарий медработника")
    evidence: Optional[dict] = Field(None, description="Доп. evidence (фото, заметки)")
    reviewer_id: str = Field(..., description="ID медработника")
    reviewer_name: Optional[str] = None
    reviewer_role: Optional[str] = None


# ---------------------------------------------------------------------------
# Ответы
# ---------------------------------------------------------------------------

class ReviewOutput(BaseModel):
    id: str
    review_type: str
    target_id: str
    event_id: Optional[str] = None
    worker_pseudonym: Optional[str] = None
    status: str
    priority: str
    assigned_reason: Optional[str] = None
    reviewer_id: Optional[str] = None
    reviewer_name: Optional[str] = None
    decision: Optional[str] = None
    decision_comment: Optional[str] = None
    decided_at: Optional[datetime] = None
    context: Optional[dict] = None
    created_at: datetime
    updated_at: datetime


class ReviewListOutput(BaseModel):
    count: int
    items: list[ReviewOutput]
