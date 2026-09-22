"""
app/core/data/anti_leak.py

Контроль утечки данных (data leakage) при расчёте baseline.

КРИТИЧЕСКОЕ ПРАВИЛО: текущее измерение НИКОГДА не входит
в расчёт своего собственного baseline. Это предотвращает
ситуацию, когда отклонение маскируется самим собой.
"""

from datetime import datetime, timedelta
from typing import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import ExaminationEvent, VitalMeasurement, MentalAssessment


# ---------------------------------------------------------------------------
# Исключение текущего события из выборки
# ---------------------------------------------------------------------------

def fetch_history_excluding_current(
    session: Session,
    worker_pseudonym: str,
    current_event_id: str,
    window_days: int = 90,
) -> list[ExaminationEvent]:
    """
    Загружает историю событий работника, ИСКЛЮЧАЯ текущее событие.

    Фильтры:
      - worker_pseudonym совпадает
      - timestamp в пределах window_days
      - event_id НЕ равен current_event_id  (⚠️ анти-утечка)
      - quality_status in ('pass', 'pass_with_warnings')  (только качественные)

    Args:
        session:            SQLAlchemy-сессия
        worker_pseudonym:   hash(SNP_ID) работника
        current_event_id:   event_id текущего события (исключается)
        window_days:        окно наблюдения в днях (default: 90)

    Returns:
        Список событий ExaminationEvent, отсортированных по времени
    """
    cutoff = datetime.utcnow() - timedelta(days=window_days)

    stmt = (
        select(ExaminationEvent)
        .where(
            ExaminationEvent.worker_pseudonym == worker_pseudonym,
            ExaminationEvent.event_id != current_event_id,       # ⚠️ анти-утечка
            ExaminationEvent.timestamp >= cutoff,
            ExaminationEvent.quality_status.in_(["pass", "pass_with_warnings"]),
        )
        .order_by(ExaminationEvent.timestamp.asc())
    )

    return list(session.execute(stmt).scalars().all())


# ---------------------------------------------------------------------------
# Сбор значений признака из истории
# ---------------------------------------------------------------------------

def collect_feature_values(
    session: Session,
    events: list[ExaminationEvent],
    feature_name: str,
    source: str = "vitals",
) -> list[float]:
    """
    Собирает значения конкретного признака из списка событий.

    Args:
        session:      SQLAlchemy-сессия
        events:       список событий (уже отфильтрованных, без текущего)
        feature_name: имя признака (heart_rate, blood_pressure_systolic, …)
        source:       "vitals" или "mental"

    Returns:
        Список значений (float)
    """
    values = []

    for event in events:
        if source == "vitals":
            vital = session.execute(
                select(VitalMeasurement).where(
                    VitalMeasurement.event_id == event.id,
                    VitalMeasurement.feature_name == feature_name,
                )
            ).scalar_one_or_none()

            if vital and vital.value is not None:
                # Дополнительная проверка качества
                if vital.confidence is not None and vital.confidence < 0.7:
                    continue
                if vital.artifact_pct is not None and vital.artifact_pct > 10:
                    continue
                values.append(float(vital.value))

        elif source == "mental":
            mental = session.execute(
                select(MentalAssessment).where(
                    MentalAssessment.event_id == event.id
                )
            ).scalar_one_or_none()

            if mental is None:
                continue

            val = None
            if feature_name == "adequacy_score":
                val = mental.adequacy_score
            elif feature_name == "speech_coherence":
                val = mental.speech_coherence
            elif feature_name == "pupil_reaction":
                val = mental.pupil_reaction

            if val is not None:
                values.append(float(val))

    return values


# ---------------------------------------------------------------------------
# Проверка: текущее событие действительно исключено
# ---------------------------------------------------------------------------

def verify_exclusion(
    events: list[ExaminationEvent],
    current_event_id: str,
) -> bool:
    """
    Проверяет, что текущее событие действительно отсутствует в выборке.

    Это страховочная функция — вызывается после fetch_history_excluding_current
    для аудита.
    """
    for event in events:
        if event.event_id == current_event_id:
            return False
    return True
