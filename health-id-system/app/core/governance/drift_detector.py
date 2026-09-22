"""
app/core/governance/drift_detector.py

Детектор дрейфа данных и модели.

Типы проверок:
  1. data_drift — распределение входных признаков изменилось
     (t-тест для средних, KS-тест для распределений)
  2. prediction_drift — распределение HEALTH_ID изменилось
  3. concept_drift — связь между входом и выходом изменилась
     (корреляция признаков с HEALTH_ID)

Сравнивается reference-окно (ранний период) с current-окном (поздний период).
"""

import uuid
from datetime import datetime, timedelta
from typing import Optional

import numpy as np
from scipy import stats as scipy_stats
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from app.db.models import (
    DriftRecord,
    HealthIdResult,
    ModelVersion,
    VitalMeasurement,
    MentalAssessment,
    ExaminationEvent,
)


# ---------------------------------------------------------------------------
# Константы
# ---------------------------------------------------------------------------

DRIFT_ALPHA = 0.05                  # уровень значимости
MIN_SAMPLES_PER_WINDOW = 10         # минимум точек в окне
DEFAULT_REFERENCE_DAYS = 30         # размер reference-окна
DEFAULT_CURRENT_DAYS = 7            # размер current-окна

# Признаки для проверки дрейфа
DRIFT_FEATURES_VITALS = [
    "heart_rate",
    "blood_pressure_systolic",
    "blood_pressure_diastolic",
    "temperature",
    "spo2",
    "alcohol_test",
]

DRIFT_FEATURES_MENTAL = [
    "adequacy_score",
    "speech_coherence",
    "pupil_reaction",
]


# ---------------------------------------------------------------------------
# Сбор данных по признаку
# ---------------------------------------------------------------------------

def _collect_vital_values(
    session: Session,
    feature_name: str,
    start: datetime,
    end: datetime,
) -> list[float]:
    """Собирает значения витального признака за период."""
    rows = session.execute(
        select(VitalMeasurement.value)
        .join(ExaminationEvent, VitalMeasurement.event_id == ExaminationEvent.id)
        .where(
            VitalMeasurement.feature_name == feature_name,
            ExaminationEvent.timestamp >= start,
            ExaminationEvent.timestamp < end,
            ExaminationEvent.quality_status.in_(["pass", "pass_with_warnings"]),
        )
    ).scalars().all()
    return [float(v) for v in rows if v is not None]


def _collect_mental_values(
    session: Session,
    feature_name: str,
    start: datetime,
    end: datetime,
) -> list[float]:
    """Собирает значения психофизиологического признака за период."""
    col = getattr(MentalAssessment, feature_name, None)
    if col is None:
        return []

    rows = session.execute(
        select(col)
        .join(ExaminationEvent, MentalAssessment.event_id == ExaminationEvent.id)
        .where(
            ExaminationEvent.timestamp >= start,
            ExaminationEvent.timestamp < end,
            ExaminationEvent.quality_status.in_(["pass", "pass_with_warnings"]),
        )
    ).scalars().all()
    return [float(v) for v in rows if v is not None]


# ---------------------------------------------------------------------------
# Сбор HEALTH_ID значений
# ---------------------------------------------------------------------------

def _collect_health_id_values(
    session: Session,
    start: datetime,
    end: datetime,
) -> list[float]:
    """Собирает значения HEALTH_ID за период."""
    rows = session.execute(
        select(HealthIdResult.value)
        .join(ExaminationEvent, HealthIdResult.event_id == ExaminationEvent.id)
        .where(
            ExaminationEvent.timestamp >= start,
            ExaminationEvent.timestamp < end,
        )
    ).scalars().all()
    return [float(v) for v in rows if v is not None]


# ---------------------------------------------------------------------------
# t-тест для средних
# ---------------------------------------------------------------------------

def _t_test(reference: list[float], current: list[float]) -> dict:
    """
    Двухвыборочный t-тест Стьюдента.

    H0: средние равны.
    H1: средние различаются.
    """
    if len(reference) < MIN_SAMPLES_PER_WINDOW or len(current) < MIN_SAMPLES_PER_WINDOW:
        return {
            "test_name": "t_test",
            "statistic": None,
            "p_value": None,
            "drift_detected": False,
            "reason": "insufficient_samples",
        }

    t_stat, p_value = scipy_stats.ttest_ind(reference, current, equal_var=False)

    if np.isnan(p_value):
        return {
            "test_name": "t_test",
            "statistic": float(t_stat) if not np.isnan(t_stat) else None,
            "p_value": None,
            "drift_detected": False,
            "reason": "nan_result",
        }

    return {
        "test_name": "t_test",
        "statistic": float(t_stat),
        "p_value": float(p_value),
        "drift_detected": p_value < DRIFT_ALPHA,
        "reason": None,
    }


# ---------------------------------------------------------------------------
# KS-тест для распределений
# ---------------------------------------------------------------------------

def _ks_test(reference: list[float], current: list[float]) -> dict:
    """
    Критерий Колмогорова-Смирнова.

    H0: распределения одинаковы.
    H1: распределения различаются.
    """
    if len(reference) < MIN_SAMPLES_PER_WINDOW or len(current) < MIN_SAMPLES_PER_WINDOW:
        return {
            "test_name": "ks_test",
            "statistic": None,
            "p_value": None,
            "drift_detected": False,
            "reason": "insufficient_samples",
        }

    ks_stat, p_value = scipy_stats.ks_2samp(reference, current)

    if np.isnan(p_value):
        return {
            "test_name": "ks_test",
            "statistic": float(ks_stat) if not np.isnan(ks_stat) else None,
            "p_value": None,
            "drift_detected": False,
            "reason": "nan_result",
        }

    return {
        "test_name": "ks_test",
        "statistic": float(ks_stat),
        "p_value": float(p_value),
        "drift_detected": p_value < DRIFT_ALPHA,
        "reason": None,
    }


# ---------------------------------------------------------------------------
# Главная функция детекции дрейфа
# ---------------------------------------------------------------------------

def detect_drift(
    session: Session,
    model_version_id: str,
    reference_days: int = DEFAULT_REFERENCE_DAYS,
    current_days: int = DEFAULT_CURRENT_DAYS,
    now: datetime | None = None,
) -> list[DriftRecord]:
    """
    Запускает полную проверку дрейфа.

    Проверяет:
      1. data_drift по каждому витальному признаку (t-тест + KS-тест)
      2. data_drift по каждому психофизиологическому признаку
      3. prediction_drift по HEALTH_ID (t-тест + KS-тест)

    Сохраняет найденные дрейфы в drift_records.

    Returns:
        Список созданных DriftRecord (только обнаруженные дрейфы)
    """
    if now is None:
        now = datetime.utcnow()

    ref_start = now - timedelta(days=reference_days + current_days)
    ref_end = now - timedelta(days=current_days)
    cur_start = ref_end
    cur_end = now

    detected_records = []

    # --- 1. Data drift: витальные признаки ---
    for feature_name in DRIFT_FEATURES_VITALS:
        ref_values = _collect_vital_values(session, feature_name, ref_start, ref_end)
        cur_values = _collect_vital_values(session, feature_name, cur_start, cur_end)

        if len(ref_values) < MIN_SAMPLES_PER_WINDOW or len(cur_values) < MIN_SAMPLES_PER_WINDOW:
            continue

        # t-тест
        t_result = _t_test(ref_values, cur_values)
        if t_result["drift_detected"]:
            ref_mean = float(np.mean(ref_values))
            ref_std = float(np.std(ref_values))
            cur_mean = float(np.mean(cur_values))
            cur_std = float(np.std(cur_values))

            severity = "critical" if abs(cur_mean - ref_mean) > 2 * ref_std else "warning"

            record = DriftRecord(
                id=str(uuid.uuid4()),
                model_version_id=model_version_id,
                drift_type="data_drift",
                feature_name=feature_name,
                detected_at=now,
                window_start=ref_start,
                window_end=cur_end,
                reference_mean=ref_mean,
                reference_std=ref_std,
                current_mean=cur_mean,
                current_std=cur_std,
                test_name=t_result["test_name"],
                statistic=t_result["statistic"],
                p_value=t_result["p_value"],
                threshold=DRIFT_ALPHA,
                severity=severity,
                description=(
                    f"Дрейф {feature_name}: среднее изменилось с "
                    f"{ref_mean:.2f} на {cur_mean:.2f} "
                    f"(p={t_result['p_value']:.4f})"
                ),
                recommended_action="Проверить калибровку приборов и условия измерений",
            )
            session.add(record)
            detected_records.append(record)

        # KS-тест (дополнительно, если t-тест не сработал)
        if not t_result["drift_detected"]:
            ks_result = _ks_test(ref_values, cur_values)
            if ks_result["drift_detected"]:
                record = DriftRecord(
                    id=str(uuid.uuid4()),
                    model_version_id=model_version_id,
                    drift_type="data_drift",
                    feature_name=feature_name,
                    detected_at=now,
                    window_start=ref_start,
                    window_end=cur_end,
                    reference_mean=float(np.mean(ref_values)),
                    reference_std=float(np.std(ref_values)),
                    current_mean=float(np.mean(cur_values)),
                    current_std=float(np.std(cur_values)),
                    test_name=ks_result["test_name"],
                    statistic=ks_result["statistic"],
                    p_value=ks_result["p_value"],
                    threshold=DRIFT_ALPHA,
                    severity="warning",
                    description=(
                        f"Дрейф распределения {feature_name} "
                        f"(KS p={ks_result['p_value']:.4f})"
                    ),
                    recommended_action="Проверить состав популяции и протоколы",
                )
                session.add(record)
                detected_records.append(record)

    # --- 2. Data drift: психофизиологические признаки ---
    for feature_name in DRIFT_FEATURES_MENTAL:
        ref_values = _collect_mental_values(session, feature_name, ref_start, ref_end)
        cur_values = _collect_mental_values(session, feature_name, cur_start, cur_end)

        if len(ref_values) < MIN_SAMPLES_PER_WINDOW or len(cur_values) < MIN_SAMPLES_PER_WINDOW:
            continue

        t_result = _t_test(ref_values, cur_values)
        if t_result["drift_detected"]:
            ref_mean = float(np.mean(ref_values))
            cur_mean = float(np.mean(cur_values))

            severity = "critical" if abs(cur_mean - ref_mean) > 1.0 else "warning"

            record = DriftRecord(
                id=str(uuid.uuid4()),
                model_version_id=model_version_id,
                drift_type="data_drift",
                feature_name=feature_name,
                detected_at=now,
                window_start=ref_start,
                window_end=cur_end,
                reference_mean=ref_mean,
                reference_std=float(np.std(ref_values)),
                current_mean=cur_mean,
                current_std=float(np.std(cur_values)),
                test_name=t_result["test_name"],
                statistic=t_result["statistic"],
                p_value=t_result["p_value"],
                threshold=DRIFT_ALPHA,
                severity=severity,
                description=(
                    f"Дрейф {feature_name}: среднее {ref_mean:.2f} → {cur_mean:.2f} "
                    f"(p={t_result['p_value']:.4f})"
                ),
                recommended_action="Проверить квалификацию медработников и протоколы оценки",
            )
            session.add(record)
            detected_records.append(record)

    # --- 3. Prediction drift: HEALTH_ID ---
    ref_hid = _collect_health_id_values(session, ref_start, ref_end)
    cur_hid = _collect_health_id_values(session, cur_start, cur_end)

    if len(ref_hid) >= MIN_SAMPLES_PER_WINDOW and len(cur_hid) >= MIN_SAMPLES_PER_WINDOW:
        t_result = _t_test(ref_hid, cur_hid)
        ks_result = _ks_test(ref_hid, cur_hid)

        if t_result["drift_detected"] or ks_result["drift_detected"]:
            ref_mean = float(np.mean(ref_hid))
            cur_mean = float(np.mean(cur_hid))

            severity = "critical" if abs(cur_mean - ref_mean) > 0.1 else "warning"

            test_info = t_result if t_result["drift_detected"] else ks_result

            record = DriftRecord(
                id=str(uuid.uuid4()),
                model_version_id=model_version_id,
                drift_type="prediction_drift",
                feature_name="health_id",
                detected_at=now,
                window_start=ref_start,
                window_end=cur_end,
                reference_mean=ref_mean,
                reference_std=float(np.std(ref_hid)),
                current_mean=cur_mean,
                current_std=float(np.std(cur_hid)),
                test_name=test_info["test_name"],
                statistic=test_info["statistic"],
                p_value=test_info["p_value"],
                threshold=DRIFT_ALPHA,
                severity=severity,
                description=(
                    f"Дрейф HEALTH_ID: среднее {ref_mean:.3f} → {cur_mean:.3f} "
                    f"({test_info['test_name']} p={test_info['p_value']:.4f})"
                ),
                recommended_action=(
                    "Проверить состав популяции, калибровку приборов, "
                    "возможно требуется пересмотр весов формулы"
                ),
            )
            session.add(record)
            detected_records.append(record)

    session.commit()
    return detected_records


# ---------------------------------------------------------------------------
# Получение записей дрейфа
# ---------------------------------------------------------------------------

def list_drift_records(
    session: Session,
    model_version_id: str | None = None,
    drift_type: str | None = None,
    resolved: bool | None = None,
    limit: int = 50,
) -> list[DriftRecord]:
    stmt = select(DriftRecord).order_by(DriftRecord.detected_at.desc())

    if model_version_id:
        stmt = stmt.where(DriftRecord.model_version_id == model_version_id)
    if drift_type:
        stmt = stmt.where(DriftRecord.drift_type == drift_type)
    if resolved is not None:
        stmt = stmt.where(DriftRecord.resolved == resolved)

    return list(session.execute(stmt.limit(limit)).scalars().all())


def resolve_drift(
    session: Session,
    drift_id: str,
    resolved_by: str = "system",
) -> DriftRecord:
    """Отмечает дрейф как разрешённый."""
    record = session.execute(
        select(DriftRecord).where(DriftRecord.id == drift_id)
    ).scalar_one_or_none()
    if record is None:
        raise ValueError(f"Запись дрейфа не найдена: {drift_id}")

    record.resolved = True
    record.resolved_at = datetime.utcnow()
    record.resolved_by = resolved_by
    session.commit()
    return record
