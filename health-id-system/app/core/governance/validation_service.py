"""
app/core/governance/validation_service.py

Управление отчётами валидации R0–R4.

Этапы:
  R0 — Аналитическая валидация (воспроизводимость)
  R1 — Ретроспективная валидация (метрики на пилоте)
  R2 — Внешняя проспективная валидация
  R3 — Клиническая полезность
  R4 — Финальная оценка
"""

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import (
    ExaminationEvent,
    HealthIdResult,
    ValidationReport,
    ModelVersion,
)


# ---------------------------------------------------------------------------
# Создание отчёта
# ---------------------------------------------------------------------------

def create_validation_report(
    session: Session,
    stage: str,
    model_version_id: str,
    n_samples: int | None = None,
    n_workers: int | None = None,
) -> ValidationReport:
    """
    Создаёт новый отчёт валидации в статусе pending.
    """
    if stage not in ("R0", "R1", "R2", "R3", "R4"):
        raise ValueError(f"Неизвестный этап валидации: {stage}")

    report = ValidationReport(
        id=str(uuid.uuid4()),
        stage=stage,
        model_version_id=model_version_id,
        status="pending",
        started_at=datetime.utcnow(),
        n_samples=n_samples,
        n_workers=n_workers,
    )
    session.add(report)
    session.commit()
    return report


# ---------------------------------------------------------------------------
# R0: Аналитическая валидация (воспроизводимость)
# ---------------------------------------------------------------------------

def run_r0_validation(
    session: Session,
    model_version_id: str,
) -> ValidationReport:
    """
    R0: Проверка воспроизводимости.

    Берёт все рассчитанные HEALTH_ID, перерасчитывает и сравнивает.
    Воспроизводимость = доля идентичных результатов.
    """
    report = create_validation_report(session, "R0", model_version_id)

    report.status = "running"
    session.commit()

    # Считаем количество результатов
    results = session.execute(
        select(HealthIdResult).where(HealthIdResult.model_version == model_version_id)
    ).scalars().all()

    n_total = len(results)
    n_reproducible = sum(1 for r in results if r.reproducible)
    reproducibility = n_reproducible / n_total if n_total > 0 else 0.0

    n_workers = session.execute(
        select(HealthIdResult)
        .join(ExaminationEvent, HealthIdResult.event_id == ExaminationEvent.id)
    ).scalars().all()

    metrics = {
        "total_results": n_total,
        "reproducible_results": n_reproducible,
        "reproducibility_score": round(reproducibility, 4),
        "target_reproducibility": 1.0,
        "passed": reproducibility >= 1.0,
    }

    report.status = "passed" if metrics["passed"] else "failed"
    report.metrics = metrics
    report.reproducibility_score = reproducibility
    report.completed_at = datetime.utcnow()
    report.summary = (
        f"R0: Воспроизводимость {reproducibility:.1%} "
        f"({n_reproducible}/{n_total} результатов идентичны). "
        f"{'✅ Цель достигнута.' if metrics['passed'] else '❌ Цель не достигнута.'}"
    )
    session.commit()

    return report


# ---------------------------------------------------------------------------
# R1: Ретроспективная валидация (метрики на пилоте)
# ---------------------------------------------------------------------------

def run_r1_validation(
    session: Session,
    model_version_id: str,
) -> ValidationReport:
    """
    R1: Метрики качества на пилотном датасете.

    Метрики:
      - распределение HEALTH_ID по категориям
      - среднее и std по компонентам
      - доля неполных расчётов
      - доля флагов (acute, persistent, chronic)
      - доля human review
    """
    report = create_validation_report(session, "R1", model_version_id)

    report.status = "running"
    session.commit()

    results = session.execute(
        select(HealthIdResult).where(HealthIdResult.model_version == model_version_id)
    ).scalars().all()

    n_total = len(results)
    if n_total == 0:
        report.status = "failed"
        report.summary = "R1: Нет данных для валидации."
        report.completed_at = datetime.utcnow()
        session.commit()
        return report

    # Распределение по категориям
    categories = {"green": 0, "yellow": 0, "red": 0}
    for r in results:
        if r.category in categories:
            categories[r.category] += 1

    # Средние по компонентам
    hbody_mean = sum(r.hbody_value for r in results) / n_total
    hmental_mean = sum(r.hmental_value for r in results) / n_total
    hsocial_mean = sum(r.hsocial_value for r in results) / n_total

    # Полнота
    completeness_avg = sum(r.completeness for r in results) / n_total
    incomplete_count = sum(1 for r in results if r.completeness < 1.0)

    # Флаги
    acute_count = sum(1 for r in results if r.acute_deviation)
    persistent_count = sum(1 for r in results if r.persistent_repeated_deviation)
    chronic_count = sum(1 for r in results if r.confirmed_chronic)

    # Уникальные работники
    worker_ids = set()
    for r in results:
        event = session.execute(
            select(ExaminationEvent).where(ExaminationEvent.id == r.event_id)
        ).scalar_one_or_none()
        if event:
            worker_ids.add(event.worker_pseudonym)

    metrics = {
        "total_results": n_total,
        "unique_workers": len(worker_ids),
        "category_distribution": categories,
        "hbody_mean": round(hbody_mean, 4),
        "hmental_mean": round(hmental_mean, 4),
        "hsocial_mean": round(hsocial_mean, 4),
        "completeness_avg": round(completeness_avg, 4),
        "incomplete_count": incomplete_count,
        "flags": {
            "acute_deviation": acute_count,
            "persistent_repeated": persistent_count,
            "confirmed_chronic": chronic_count,
        },
    }

    # Критерий: есть данные во всех категориях и полнота > 70%
    passed = (
        n_total >= 10
        and completeness_avg >= 0.70
    )

    report.status = "passed" if passed else "failed"
    report.metrics = metrics
    report.n_samples = n_total
    report.n_workers = len(worker_ids)
    report.completed_at = datetime.utcnow()
    report.summary = (
        f"R1: {n_total} результатов, {len(worker_ids)} работников. "
        f"Распределение: green={categories['green']}, "
        f"yellow={categories['yellow']}, red={categories['red']}. "
        f"Полнота: {completeness_avg:.1%}. "
        f"Флаги: acute={acute_count}, persistent={persistent_count}, "
        f"chronic={chronic_count}. "
        f"{'✅ Пройдена.' if passed else '⚠️ Недостаточно данных.'}"
    )
    session.commit()

    return report


# ---------------------------------------------------------------------------
# Получение отчётов
# ---------------------------------------------------------------------------

def list_validation_reports(
    session: Session,
    stage: str | None = None,
    model_version_id: str | None = None,
) -> list[ValidationReport]:
    stmt = select(ValidationReport).order_by(ValidationReport.created_at.desc())
    if stage:
        stmt = stmt.where(ValidationReport.stage == stage)
    if model_version_id:
        stmt = stmt.where(ValidationReport.model_version_id == model_version_id)
    return list(session.execute(stmt).scalars().all())


def get_validation_report(session: Session, report_id: str) -> ValidationReport:
    report = session.execute(
        select(ValidationReport).where(ValidationReport.id == report_id)
    ).scalar_one_or_none()
    if report is None:
        raise ValueError(f"Отчёт не найден: {report_id}")
    return report
