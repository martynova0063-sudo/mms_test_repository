"""
app/core/review/review_service.py

Модуль 7: Бизнес-логика Human Review.

Создание, назначение, подтверждение, отклонение, эскалация.
Контроль переходов статусов и аудит.
"""

import uuid
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.db.models import (
    ExaminationEvent,
    HealthIdResult,
    ReviewRecord,
)
from app.core.review.review_audit import log_review_action


# ---------------------------------------------------------------------------
# Допустимые переходы статусов
# ---------------------------------------------------------------------------

VALID_TRANSITIONS = {
    "pending":    {"confirmed", "rejected", "escalated"},
    "confirmed":   {},                    # терминальный
    "rejected":   {},                    # терминальный
    "escalated":  {"confirmed", "rejected"},  # можно дозаполнить после эскалации
}


# ---------------------------------------------------------------------------
# Создание review
# ---------------------------------------------------------------------------

def create_review(
    session: Session,
    review_type: str,
    target_id: str,
    event_id: str | None = None,
    worker_pseudonym: str | None = None,
    assigned_reason: str | None = None,
    priority: str = "normal",
    context: dict | None = None,
    assigned_by: str = "system",
    expires_hours: int = 72,
) -> ReviewRecord:
    """
    Создаёт новую запись review.

    Проверяет:
      - review_type валиден
      - нет активного review для того же target_id (pending/escalated)
      - context формируется автоматически, если не передан

    Args:
        review_type: verification | health_id | classification
        target_id:  ID проверяемой записи
        event_id:   event_id (опц.)
        ...
    """
    if review_type not in ("verification", "health_id", "classification"):
        raise ValueError(f"Неизвестный тип review: {review_type}")

    # Проверка: нет ли уже активного review для этого target
    existing = session.execute(
        select(ReviewRecord).where(
            ReviewRecord.target_id == target_id,
            ReviewRecord.review_type == review_type,
            ReviewRecord.status.in_(["pending", "escalated"]),
        )
    ).scalar_one_or_none()

    if existing:
        raise ValueError(
            f"Уже есть активный review ({existing.id}, status={existing.status}) "
            f"для {review_type}:{target_id}"
        )

    # Если event_id передан — находим event в БД
    event_db_id = None
    if event_id:
        event = session.execute(
            select(ExaminationEvent).where(
                ExaminationEvent.event_id == event_id
            )
        ).scalar_one_or_none()
        if event:
            event_db_id = event.id
            if worker_pseudonym is None:
                worker_pseudonym = event.worker_pseudonym

    # Автоматическое формирование context
    if context is None:
        context = _build_auto_context(session, review_type, target_id, event_id)

    review = ReviewRecord(
        id=str(uuid.uuid4()),
        review_type=review_type,
        target_id=target_id,
        event_id=event_db_id,
        worker_pseudonym=worker_pseudonym,
        status="pending",
        assigned_by=assigned_by,
        assigned_reason=assigned_reason,
        priority=priority,
        context=context,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
        expires_at=datetime.utcnow() + timedelta(hours=expires_hours),
    )
    session.add(review)
    session.commit()

    # Аудит
    log_review_action(
        session=session,
        review_id=review.id,
        action="created",
        actor=assigned_by,
        details={
            "review_type": review_type,
            "target_id": target_id,
            "priority": priority,
            "assigned_reason": assigned_reason,
        },
    )

    return review


# ---------------------------------------------------------------------------
# Автоматическое формирование контекста
# ---------------------------------------------------------------------------

def _build_auto_context(
    session: Session,
    review_type: str,
    target_id: str,
    event_id: str | None,
) -> dict:
    """
    Формирует контекст для медработника — что он видит при открытии review.

    Для health_id / classification:
      - значение HEALTH_ID, категория
      - state_flags
      - human_readable
      - dominant_flag

    Для verification:
      - match_score, liveness, quality (передаётся извне)
    """
    context = {}

    if review_type in ("health_id", "classification"):
        result = session.execute(
            select(HealthIdResult).where(HealthIdResult.id == target_id)
        ).scalar_one_or_none()

        if result:
            context = {
                "health_id_value": result.value,
                "health_id_category": result.category,
                "completeness": result.completeness,
                "uncertainty": result.uncertainty,
                "dominant_flag": None,
                "state_flags": [],
                "human_readable": result.human_readable,
                "disclaimer": result.disclaimer,
                "model_version": result.model_version,
            }

            # Извлекаем state_flags из evidence
            if result.evidence:
                context["state_flags"] = result.evidence.get("state_flags", [])
                context["dominant_flag"] = _extract_dominant(result.evidence)

    elif review_type == "verification":
        context = {
            "match_score": None,
            "liveness_score": None,
            "quality_report": None,
            "note": "Контекст верификации передаётся из Модуля 1",
        }

    return context


def _extract_dominant(evidence: dict) -> str | None:
    """Извлекает доминантный флаг из evidence."""
    flags = evidence.get("state_flags", [])
    for f in flags:
        if f.get("active") and f.get("flag") in (
            "confirmed_chronic", "persistent_repeated_deviation",
            "acute_deviation", "personal_deviation"
        ):
            # Возвращаем первый активный в порядке приоритета
            pass
    # Простой возврат
    priority_order = ["confirmed_chronic", "persistent_repeated_deviation",
                      "acute_deviation", "personal_deviation"]
    for p in priority_order:
        if any(f.get("flag") == p and f.get("active") for f in flags):
            return p
    return None


# ---------------------------------------------------------------------------
# Принятие решения по review
# ---------------------------------------------------------------------------

def make_decision(
    session: Session,
    review_id: str,
    decision: str,
    reviewer_id: str,
    reviewer_name: str | None = None,
    reviewer_role: str | None = None,
    comment: str | None = None,
    evidence: dict | None = None,
) -> ReviewRecord:
    """
    Медработник принимает решение по review.

    Допустимые решения:
      confirmed — подтверждает (результат верен, личность совпала и т.д.)
      rejected  — отклоняет (результат ошибочен, личность не совпала)
      escalated — эскалирует (нужен старший медработник)

    Проверки:
      - review существует
      - статус = pending или escalated
      - переход допустим
      - reviewer_id заполнен
    """
    review = session.execute(
        select(ReviewRecord).where(ReviewRecord.id == review_id)
    ).scalar_one_or_none()

    if review is None:
        raise ValueError(f"Review не найден: {review_id}")

    if decision not in ("confirmed", "rejected", "escalated"):
        raise ValueError(f"Недопустимое решение: {decision}")

    # Проверка перехода
    allowed = VALID_TRANSITIONS.get(review.status, set())
    if decision not in allowed:
        raise ValueError(
            f"Переход '{review.status}' → '{decision}' недопустим. "
            f"Допустимые: {allowed or 'нет (терминальный статус)'}"
        )

    # Проверка, что review не истёк
    if review.expires_at and datetime.utcnow() > review.expires_at:
        raise ValueError(f"Review истёк: {review.expires_at.isoformat()}")

    # Проверка, что другой медработник не забрал review
    if review.reviewer_id and review.reviewer_id != reviewer_id:
        if review.status == "pending":
            raise ValueError(
                f"Review уже взят другим медработником: {review.reviewer_id}"
            )

    # Обновление
    old_status = review.status
    review.status = decision
    review.decision = decision
    review.decision_comment = comment
    review.decision_evidence = evidence
    review.reviewer_id = reviewer_id
    review.reviewer_name = reviewer_name
    review.reviewer_role = reviewer_role
    review.decided_at = datetime.utcnow()
    review.updated_at = datetime.utcnow()

    session.commit()

    # Аудит
    log_review_action(
        session=session,
        review_id=review.id,
        action="decision",
        actor=reviewer_id,
        details={
            "old_status": old_status,
            "new_status": decision,
            "comment": comment,
            "reviewer_name": reviewer_name,
            "reviewer_role": reviewer_role,
        },
    )

    return review


# ---------------------------------------------------------------------------
# Назначение медработника (взять в работу)
# ---------------------------------------------------------------------------

def assign_reviewer(
    session: Session,
    review_id: str,
    reviewer_id: str,
    reviewer_name: str | None = None,
    reviewer_role: str | None = None,
) -> ReviewRecord:
    """
    Медработник берёт review в работу (без решения).

    Защищает от ситуации, когда два медработника одновременно
    открывают один review.
    """
    review = session.execute(
        select(ReviewRecord).where(ReviewRecord.id == review_id)
    ).scalar_one_or_none()

    if review is None:
        raise ValueError(f"Review не найден: {review_id}")

    if review.status not in ("pending", "escalated"):
        raise ValueError(f"Review не может быть взят: статус={review.status}")

    if review.reviewer_id and review.reviewer_id != reviewer_id:
        raise ValueError(f"Review уже назначен на: {review.reviewer_id}")

    review.reviewer_id = reviewer_id
    review.reviewer_name = reviewer_name
    review.reviewer_role = reviewer_role
    review.updated_at = datetime.utcnow()

    session.commit()

    log_review_action(
        session=session,
        review_id=review.id,
        action="assigned",
        actor=reviewer_id,
        details={"reviewer_name": reviewer_name, "reviewer_role": reviewer_role},
    )

    return review


# ---------------------------------------------------------------------------
# Получение review
# ---------------------------------------------------------------------------

def get_review(session: Session, review_id: str) -> ReviewRecord:
    """Получение review по ID."""
    review = session.execute(
        select(ReviewRecord).where(ReviewRecord.id == review_id)
    ).scalar_one_or_none()
    if review is None:
        raise ValueError(f"Review не найден: {review_id}")
    return review


def list_reviews(
    session: Session,
    status: str | None = None,
    review_type: str | None = None,
    reviewer_id: str | None = None,
    worker_pseudonym: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> list[ReviewRecord]:
    """Список review с фильтрами."""
    stmt = select(ReviewRecord).order_by(ReviewRecord.created_at.desc())

    if status:
        stmt = stmt.where(ReviewRecord.status == status)
    if review_type:
        stmt = stmt.where(ReviewRecord.review_type == review_type)
    if reviewer_id:
        stmt = stmt.where(ReviewRecord.reviewer_id == reviewer_id)
    if worker_pseudonym:
        stmt = stmt.where(ReviewRecord.worker_pseudonym == worker_pseudonym)

    stmt = stmt.offset(offset).limit(limit)
    return list(session.execute(stmt).scalars().all())


# ---------------------------------------------------------------------------
# Автоматическое создание review при срабатывании флагов
# ---------------------------------------------------------------------------

def auto_create_review_for_health_id(
    session: Session,
    result: HealthIdResult,
) -> ReviewRecord | None:
    """
    Автоматически создаёт review, если:
      - HEALTH_ID в красной зоне (< 0.60)
      - ИЛИ есть confirmed_chronic
      - ИЛИ есть acute_deviation с severity=critical

    Returns:
      ReviewRecord или None (если review не нужен)
    """
    needs_review = False
    reason_parts = []

    if result.value < 0.60:
        needs_review = True
        reason_parts.append(f"HEALTH_ID={result.value:.2f} < 0.60 (красная зона)")

    if result.confirmed_chronic:
        needs_review = True
        reason_parts.append("confirmed_chronic — хроническое отклонение")

    if result.evidence:
        flags = result.evidence.get("state_flags", [])
        for f in flags:
            if f.get("flag") == "acute_deviation" and f.get("active"):
                if f.get("severity") == "critical":
                    needs_review = True
                    reason_parts.append(
                        f"acute_deviation (critical) по признаку {f.get('feature')}"
                    )

    if not needs_review:
        return None

    # Получаем event_id
    event = session.execute(
        select(ExaminationEvent).where(ExaminationEvent.id == result.event_id)
    ).scalar_one_or_none()

    review = create_review(
        session=session,
        review_type="health_id",
        target_id=result.id,
        event_id=event.event_id if event else None,
        worker_pseudonym=event.worker_pseudonym if event else None,
        assigned_reason="; ".join(reason_parts),
        priority="high" if result.value < 0.60 else "normal",
    )

    return review
