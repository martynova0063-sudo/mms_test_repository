"""
app/api/routes/review.py

Модуль 7: API для Human Review.

Эндпоинты:
  POST   /api/v1/review              — создать review
  GET    /api/v1/review              — список (фильтры)
  GET    /api/v1/review/{id}         — получить review
  POST   /api/v1/review/{id}/assign  — взять в работу
  POST   /api/v1/review/{id}/decision — принять решение
  GET    /api/v1/review/{id}/audit   — аудит-трейл
  GET    /api/v1/review/pending      — список ожидающих
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from typing import Optional

from app.db.session import get_session
from app.schemas.review import (
    CreateReviewRequest,
    ReviewDecisionRequest,
    ReviewOutput,
    ReviewListOutput,
)
from app.core.review.review_service import (
    create_review,
    make_decision,
    assign_reviewer,
    get_review,
    list_reviews,
)
from app.core.review.review_audit import get_audit_trail


router = APIRouter(prefix="/api/v1/review", tags=["Human Review"])


# ---------------------------------------------------------------------------
# POST /api/v1/review — создать review
# ---------------------------------------------------------------------------

@router.post("", response_model=ReviewOutput)
def create(
    request: CreateReviewRequest,
    session: Session = Depends(get_session),
):
    """Создать новую запись human review."""
    try:
        review = create_review(
            session=session,
            review_type=request.review_type,
            target_id=request.target_id,
            event_id=request.event_id,
            worker_pseudonym=request.worker_pseudonym,
            assigned_reason=request.assigned_reason,
            priority=request.priority,
            context=request.context,
        )
    except ValueError as e:
        raise HTTPException(409, str(e))

    return _to_output(review)


# ---------------------------------------------------------------------------
# GET /api/v1/review — список с фильтрами
# ---------------------------------------------------------------------------

@router.get("", response_model=ReviewListOutput)
def list_all(
    status: Optional[str] = Query(None),
    review_type: Optional[str] = Query(None),
    reviewer_id: Optional[str] = Query(None),
    worker_pseudonym: Optional[str] = Query(None),
    limit: int = Query(50, le=200),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_session),
):
    """Список review с фильтрами."""
    reviews = list_reviews(
        session=session,
        status=status,
        review_type=review_type,
        reviewer_id=reviewer_id,
        worker_pseudonym=worker_pseudonym,
        limit=limit,
        offset=offset,
    )
    return ReviewListOutput(
        count=len(reviews),
        items=[_to_output(r) for r in reviews],
    )


# ---------------------------------------------------------------------------
# GET /api/v1/review/pending — ожидающие review
# ---------------------------------------------------------------------------

@router.get("/pending", response_model=ReviewListOutput)
def list_pending(
    review_type: Optional[str] = Query(None),
    limit: int = Query(50, le=200),
    session: Session = Depends(get_session),
):
    """Список review в статусе pending (для дашборда медработника)."""
    reviews = list_reviews(
        session=session,
        status="pending",
        review_type=review_type,
        limit=limit,
    )
    return ReviewListOutput(
        count=len(reviews),
        items=[_to_output(r) for r in reviews],
    )


# ---------------------------------------------------------------------------
# GET /api/v1/review/{review_id} — получить review
# ---------------------------------------------------------------------------

@router.get("/{review_id}", response_model=ReviewOutput)
def get_one(
    review_id: str,
    session: Session = Depends(get_session),
):
    """Получить review по ID."""
    try:
        review = get_review(session, review_id)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return _to_output(review)


# ---------------------------------------------------------------------------
# POST /api/v1/review/{review_id}/assign — взять в работу
# ---------------------------------------------------------------------------

@router.post("/{review_id}/assign", response_model=ReviewOutput)
def assign(
    review_id: str,
    reviewer_id: str = Query(...),
    reviewer_name: Optional[str] = Query(None),
    reviewer_role: Optional[str] = Query(None),
    session: Session = Depends(get_session),
):
    """Медработник берёт review в работу."""
    try:
        review = assign_reviewer(
            session=session,
            review_id=review_id,
            reviewer_id=reviewer_id,
            reviewer_name=reviewer_name,
            reviewer_role=reviewer_role,
        )
    except ValueError as e:
        raise HTTPException(409, str(e))
    return _to_output(review)


# ---------------------------------------------------------------------------
# POST /api/v1/review/{review_id}/decision — решение
# ---------------------------------------------------------------------------

@router.post("/{review_id}/decision", response_model=ReviewOutput)
def decision(
    review_id: str,
    request: ReviewDecisionRequest,
    session: Session = Depends(get_session),
):
    """
    Медработник принимает решение по review.

    decision:
      confirmed — подтверждает результат
      rejected  — отклоняет результат
      escalated — эскалирует старшему медработнику
    """
    try:
        review = make_decision(
            session=session,
            review_id=review_id,
            decision=request.decision,
            reviewer_id=request.reviewer_id,
            reviewer_name=request.reviewer_name,
            reviewer_role=request.reviewer_role,
            comment=request.comment,
            evidence=request.evidence,
        )
    except ValueError as e:
        raise HTTPException(409, str(e))
    return _to_output(review)


# ---------------------------------------------------------------------------
# GET /api/v1/review/{review_id}/audit — аудит-трейл
# ---------------------------------------------------------------------------

@router.get("/{review_id}/audit")
def audit_trail(
    review_id: str,
    session: Session = Depends(get_session),
):
    """Возвращает историю всех действий по review."""
    trail = get_audit_trail(session, review_id)
    return {
        "review_id": review_id,
        "count": len(trail),
        "entries": [
            {
                "id": e.id,
                "action": e.action,
                "actor": e.actor,
                "actor_role": e.actor_role,
                "timestamp": e.timestamp.isoformat() if e.timestamp else None,
                "details": e.details,
            }
            for e in trail
        ],
    }


# ---------------------------------------------------------------------------
# Вспомогательное
# ---------------------------------------------------------------------------

def _to_output(review) -> ReviewOutput:
    """Преобразует ReviewRecord → ReviewOutput."""
    return ReviewOutput(
        id=review.id,
        review_type=review.review_type,
        target_id=review.target_id,
        event_id=review.event_id,
        worker_pseudonym=review.worker_pseudonym,
        status=review.status,
        priority=review.priority,
        assigned_reason=review.assigned_reason,
        reviewer_id=review.reviewer_id,
        reviewer_name=review.reviewer_name,
        decision=review.decision,
        decision_comment=review.decision_comment,
        decided_at=review.decided_at,
        context=review.context,
        created_at=review.created_at,
        updated_at=review.updated_at,
    )
