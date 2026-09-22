"""
app/core/review/review_audit.py

Аудит-лог для Human Review (append-only).

Каждое действие с review фиксируется в отдельной таблице аудита,
которая никогда не обновляется и не удаляется.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Column, String, DateTime, Text, JSON, Index
from sqlalchemy.orm import Session

from app.db.models import Base


# ---------------------------------------------------------------------------
# Модель аудита (определяется здесь, чтобы не зависеть от основной модели)
# ---------------------------------------------------------------------------

class ReviewAuditLog(Base):
    """Append-only аудит-лог для human review."""
    __tablename__ = "review_audit_log"

    id = Column(String(36), primary_key=True)
    review_id = Column(String(36), nullable=False, index=True)
    action = Column(String(32), nullable=False, index=True)
    # created | assigned | decision | viewed | escalated | expired
    actor = Column(String(64), nullable=False)
    actor_role = Column(String(64), nullable=True)
    timestamp = Column(DateTime, nullable=False, index=True)
    details = Column(JSON, nullable=True)

    __table_args__ = (
        Index("ix_audit_review_action", "review_id", "action"),
    )


# ---------------------------------------------------------------------------
# Запись в аудит-лог
# ---------------------------------------------------------------------------

def log_review_action(
    session: Session,
    review_id: str,
    action: str,
    actor: str,
    actor_role: str | None = None,
    details: dict | None = None,
):
    """
    Записывает действие в аудит-лог.

    Args:
        session:   SQLAlchemy-сессия
        review_id:  ID review
        action:     created | assigned | decision | viewed | escalated | expired
        actor:      кто выполнил (system | reviewer_id)
        actor_role: роль (doctor | nurse | senior_doctor | system)
        details:    доп. детали (JSON)
    """
    entry = ReviewAuditLog(
        id=str(uuid.uuid4()),
        review_id=review_id,
        action=action,
        actor=actor,
        actor_role=actor_role,
        timestamp=datetime.utcnow(),
        details=details,
    )
    session.add(entry)
    session.commit()


# ---------------------------------------------------------------------------
# Получение истории аудита
# ---------------------------------------------------------------------------

def get_audit_trail(
    session: Session,
    review_id: str,
) -> list[ReviewAuditLog]:
    """Возвращает всю историю действий по review."""
    from sqlalchemy import select
    return list(
        session.execute(
            select(ReviewAuditLog)
            .where(ReviewAuditLog.review_id == review_id)
            .order_by(ReviewAuditLog.timestamp.asc())
        ).scalars().all()
    )
