"""
app/core/classification/state_classifier.py

Модуль 5: Классификация состояния.

Главный классификатор, объединяющий:
  1. Результат HEALTH_ID (значение + категория)
  2. Отклонения от персонального коридора (baseline)
  3. Историю отклонений (для persistent / chronic)

Выход: список state_flags в формате выходного контракта (раздел 9.1).
"""

from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import select, and_
from sqlalchemy.orm import Session

from app.db.models import (
    ExaminationEvent,
    HealthIdResult,
    VitalMeasurement,
    MentalAssessment,
)
from app.core.data.anti_leak import fetch_history_excluding_current
from app.core.data.baseline import (
    Baseline,
    DeviationResult,
    check_deviation,
    collect_feature_values,
)
from app.core.classification.rules import (
    ClassificationResult,
    HistoricalDeviation,
    StateFlag,
    check_acute_deviation,
    check_confirmed_chronic,
    check_persistent_deviation,
    check_personal_deviation,
    get_dominant_flag,
)


# ---------------------------------------------------------------------------
# Сбор истории отклонений из БД
# ---------------------------------------------------------------------------

def collect_historical_deviations(
    session: Session,
    worker_pseudonym: str,
    current_event_id: str,
    baseline: Baseline,
    window_days: int = 90,
) -> list[HistoricalDeviation]:
    if not baseline.available:
        return []

    # Получаем популяционные нормы из конфига
    try:
        config = get_default_config()
        normal_ranges = {}
        for comp in config.components.values():
            for feat in comp.features:
                if feat.normal_range:
                    normal_ranges[feat.name] = feat.normal_range
    except Exception:
        normal_ranges = {}

    history_events = fetch_history_excluding_current(
        session=session,
        worker_pseudonym=worker_pseudonym,
        current_event_id=current_event_id,
        window_days=window_days,
    )

    deviations = []

    for event in history_events:
        vitals = session.execute(
            select(VitalMeasurement).where(
                VitalMeasurement.event_id == event.id
            )
        ).scalars().all()

        for vital in vitals:
            if vital.value is None:
                continue
            val = float(vital.value)
            fname = vital.feature_name

            # Проверка против baseline-коридора
            fb = baseline.features.get(fname)
            if fb and fb.available:
                dev = check_deviation(val, fb, fname)
                if not dev.in_corridor:
                    deviations.append(HistoricalDeviation(
                        event_id=event.event_id,
                        timestamp=event.timestamp,
                        feature_name=fname,
                        value=val,
                        deviation_type=dev.deviation_type,
                        sigma=dev.sigma,
                    ))
                    continue  # уже добавили — не дублируем

            # Проверка против популяционной нормы
            nr = normal_ranges.get(fname)
            if nr:
                nr_low, nr_high = float(nr[0]), float(nr[1])
                if val > nr_high:
                    deviations.append(HistoricalDeviation(
                        event_id=event.event_id,
                        timestamp=event.timestamp,
                        feature_name=fname,
                        value=val,
                        deviation_type="above_norm",
                        sigma=abs(val - nr_high) / (nr_high - nr_low) if nr_high != nr_low else 1.0,
                    ))
                elif val < nr_low:
                    deviations.append(HistoricalDeviation(
                        event_id=event.event_id,
                        timestamp=event.timestamp,
                        feature_name=fname,
                        value=val,
                        deviation_type="below_norm",
                        sigma=abs(nr_low - val) / (nr_high - nr_low) if nr_high != nr_low else 1.0,
                    ))

        # Психофизиология — аналогично
        mental = session.execute(
            select(MentalAssessment).where(
                MentalAssessment.event_id == event.id
            )
        ).scalar_one_or_none()

        if mental:
            mental_map = {
                "adequacy_score": mental.adequacy_score,
                "speech_coherence": mental.speech_coherence,
                "pupil_reaction": mental.pupil_reaction,
            }

            for name, mval in mental_map.items():
                if mval is None:
                    continue
                val = float(mval)

                # Проверка против baseline
                fb = baseline.features.get(name)
                if fb and fb.available:
                    dev = check_deviation(val, fb, name)
                    if not dev.in_corridor:
                        deviations.append(HistoricalDeviation(
                            event_id=event.event_id,
                            timestamp=event.timestamp,
                            feature_name=name,
                            value=val,
                            deviation_type=dev.deviation_type,
                            sigma=dev.sigma,
                        ))
                        continue

                # Проверка против нормы
                nr = normal_ranges.get(name)
                if nr:
                    nr_low, nr_high = float(nr[0]), float(nr[1])
                    if val > nr_high:
                        deviations.append(HistoricalDeviation(
                            event_id=event.event_id,
                            timestamp=event.timestamp,
                            feature_name=name,
                            value=val,
                            deviation_type="above_norm",
                            sigma=abs(val - nr_high) / (nr_high - nr_low) if nr_high != nr_low else 1.0,
                        ))
                    elif val < nr_low:
                        deviations.append(HistoricalDeviation(
                            event_id=event.event_id,
                            timestamp=event.timestamp,
                            feature_name=name,
                            value=val,
                            deviation_type="below_norm",
                            sigma=abs(nr_low - val) / (nr_high - nr_low) if nr_high != nr_low else 1.0,
                        ))

    return deviations


# ---------------------------------------------------------------------------
# Главная функция классификации
# ---------------------------------------------------------------------------

def classify_state(
    session: Session,
    health_id_result: HealthIdResult,
    baseline: Baseline,
    current_deviations: list[DeviationResult],
    worker_pseudonym: str,
    current_event_id: str,
) -> ClassificationResult:
    """
    Полная классификация состояния работника.

    Объединяет 4 правила:
      1. acute_deviation — острое отклонение
      2. persistent_repeated_deviation — повторяющееся
      3. confirmed_chronic — хроническое
      4. personal_deviation — персональное

    Args:
        session:             SQLAlchemy-сессия
        health_id_result:    результат расчёта HEALTH_ID
        baseline:            рассчитанный baseline
        current_deviations:  отклонения текущего события от baseline
        worker_pseudonym:    hash(SNP_ID)
        current_event_id:   event_id текущего события

    Returns:
        ClassificationResult с флагами
    """
    health_id_value = health_id_result.value
    health_id_category = health_id_result.category

    # --- 1. Сбор истории отклонений ---
    historical_deviations = collect_historical_deviations(
        session=session,
        worker_pseudonym=worker_pseudonym,
        current_event_id=current_event_id,
        baseline=baseline,
        window_days=90,
    )

    # --- 2. Применение правил ---
    flags = []

    # Правило 1: Острое отклонение
    acute_flag = check_acute_deviation(current_deviations, health_id_value)
    flags.append(acute_flag)

    # Правило 2: Повторяющееся отклонение
    persistent_flag = check_persistent_deviation(
        current_deviations,
        historical_deviations,
    )
    flags.append(persistent_flag)

    # Правило 3: Подтверждённое хроническое
    chronic_flag = check_confirmed_chronic(
        current_deviations,
        historical_deviations,
    )
    flags.append(chronic_flag)

    # Правило 4: Персональное отклонение
    personal_flag = check_personal_deviation(current_deviations)
    flags.append(personal_flag)

    # --- 3. Доминантный флаг ---
    dominant = get_dominant_flag(flags)

    # --- 4. Формирование результата ---
    result = ClassificationResult(
        health_id_value=health_id_value,
        health_id_category=health_id_category,
        flags=flags,
        dominant_flag=dominant,
    )

    # --- 5. Текстовая сводка ---
    result.summary = _build_summary(result, current_deviations)

    return result


# ---------------------------------------------------------------------------
# Текстовая сводка
# ---------------------------------------------------------------------------

def _build_summary(result: ClassificationResult, deviations: list[DeviationResult]) -> str:
    """Генерирует краткую текстовую сводку для выходного контракта."""
    lines = []

    if result.dominant_flag is None:
        lines.append("Состояние в норме. Отклонений не обнаружено.")
        return " ".join(lines)

    flag_names_ru = {
        "acute_deviation": "Острое отклонение",
        "persistent_repeated_deviation": "Повторяющееся отклонение",
        "confirmed_chronic": "Подтверждённое хроническое отклонение",
        "personal_deviation": "Персональное отклонение",
    }

    for flag in result.flags:
        if not flag.active:
            continue
        name_ru = flag_names_ru.get(flag.flag, flag.flag)
        lines.append(f"⚠️ {name_ru}: {flag.feature}")
        if flag.evidence:
            for ev in flag.evidence:
                lines.append(f"   → {ev}")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Обновление HealthIdResult в БД
# ---------------------------------------------------------------------------

def apply_classification_to_result(
    session: Session,
    result: HealthIdResult,
    classification: ClassificationResult,
) -> HealthIdResult:
    """
    Записывает флаги классификации в HealthIdResult.

    Обновляет поля:
      - acute_deviation
      - persistent_repeated_deviation
      - confirmed_chronic
      - personal_deviation
      - personal_deviation_feature
      - personal_deviation_detail
    """
    for flag in classification.flags:
        if flag.flag == "acute_deviation":
            result.acute_deviation = flag.active
        elif flag.flag == "persistent_repeated_deviation":
            result.persistent_repeated_deviation = flag.active
        elif flag.flag == "confirmed_chronic":
            result.confirmed_chronic = flag.active
        elif flag.flag == "personal_deviation":
            result.personal_deviation = flag.active
            result.personal_deviation_feature = flag.feature
            result.personal_deviation_detail = flag.to_dict() if flag.active else None

    # Добавляем флаги в evidence
    if result.evidence:
        result.evidence["state_flags"] = classification.to_state_flags_list()
        result.evidence["classification_summary"] = classification.summary

    session.commit()
    return result


# ---------------------------------------------------------------------------
# CLI-запуск для тестирования
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys
    from sqlalchemy import create_engine

    from app.db.models import Base, SocialContext
    from app.core.data.intake import intake_event
    from app.core.data.baseline import calculate_baseline, check_all_deviations
    from app.core.engine.health_id_engine import calculate_health_id

    db_url = sys.argv[1] if len(sys.argv) > 1 else "sqlite:///health_id_class.db"
    engine = create_engine(db_url)
    Base.metadata.create_all(engine)

    worker = "hash_worker_class_test"

    def make_payload(event_id, ts, hr, bp_s, bp_d, temp, spo2, alc, adeq, speech, pupil):
        return {
            "event_id": event_id,
            "event_type": "periodic_medical_examination",
            "worker_pseudonym": worker,
            "timestamp": ts,
            "measurements": {
                "vitals": [
                    {"name": "heart_rate", "value": hr, "unit": "bpm",
                     "measurement_protocol": "std", "confidence": 0.95,
                     "artifact_pct": 2, "timestamp": ts},
                    {"name": "blood_pressure_systolic", "value": bp_s, "unit": "mmHg",
                     "measurement_protocol": "std", "confidence": 0.92,
                     "artifact_pct": 1, "timestamp": ts},
                    {"name": "blood_pressure_diastolic", "value": bp_d, "unit": "mmHg",
                     "measurement_protocol": "std", "confidence": 0.92,
                     "artifact_pct": 1, "timestamp": ts},
                    {"name": "temperature", "value": temp, "unit": "°C",
                     "measurement_protocol": "std", "confidence": 0.98,
                     "artifact_pct": 0, "timestamp": ts},
                    {"name": "spo2", "value": spo2, "unit": "%",
                     "measurement_protocol": "std", "confidence": 0.96,
                     "artifact_pct": 0, "timestamp": ts},
                    {"name": "alcohol_test", "value": alc, "unit": "mg/l",
                     "measurement_protocol": "std", "confidence": 0.99,
                     "artifact_pct": 0, "timestamp": ts},
                ],
                "mental": [
                    {"name": "adequacy_score", "value": adeq, "confidence": 0.9,
                     "source": "measured", "timestamp": ts},
                    {"name": "speech_coherence", "value": speech, "confidence": 0.85,
                     "source": "derived", "timestamp": ts},
                    {"name": "pupil_reaction", "value": pupil, "confidence": 0.85,
                     "source": "measured", "timestamp": ts},
                ],
                "context": {
                    "workplace": "plant_A",
                    "shift": "morning",
                    "examination_type": "periodic",
                },
            },
            "metadata": {
                "mis_source": "ECOZ",
                "transmission_id": f"trans_{event_id}",
                "transmission_timestamp": ts,
            },
        }

    # История: 5 событий с нормальным АД (120-125), но 2 события
    # (30 и 15 дней назад) с повышенным АД (140-145)
    events_data = [
        # (event_id, timestamp, hr, bp_s, bp_d, temp, spo2, alc, adeq, speech, pupil)
        ("hist_01", "2026-06-01T10:00:00+04:00", 72, 120, 78, 36.6, 98, 0.0, 8, 8, 9),
        ("hist_02", "2026-07-01T10:00:00+04:00", 74, 122, 80, 36.7, 97, 0.0, 8, 8, 9),
        ("hist_03", "2026-08-01T10:00:00+04:00", 73, 125, 82, 36.8, 97, 0.0, 8, 8, 9),
        # 30 дней назад — первое повышенное АД
        ("hist_04", "2026-08-17T10:00:00+04:00", 75, 140, 85, 36.6, 98, 0.0, 7, 7, 8),
        # 15 дней назад — второе повышенное АД
        ("hist_05", "2026-09-02T10:00:00+04:00", 76, 142, 86, 36.6, 98, 0.0, 7, 7, 8),
        # Текущее событие — снова повышенное АД (145)
        ("curr_01", "2026-09-17T10:30:00+04:00", 75, 145, 87, 36.6, 98, 0.0, 8, 8, 9),
    ]

    with Session(engine) as session:
        # 1. Загрузка всех событий
        print("=== ЗАГРУЗКА ДАННЫХ ===")
        for eid, ts, hr, bp_s, bp_d, temp, spo2, alc, adeq, speech, pupil in events_data:
            payload = make_payload(eid, ts, hr, bp_s, bp_d, temp, spo2, alc, adeq, speech, pupil)
            intake_event(payload, session)

            # Заполняем social
            event = session.execute(
                select(ExaminationEvent).where(ExaminationEvent.event_id == eid)
            ).scalar_one()
            social = session.execute(
                select(SocialContext).where(SocialContext.event_id == event.id)
            ).scalar_one()
            social.examination_regularity = 0.94
            social.missed_examinations = 1
            session.commit()

        # 2. Расчёт HEALTH_ID для текущего события
        print()
        print("=== РАСЧЁТ HEALTH_ID ===")
        result = calculate_health_id("curr_01", session)
        print(f"  HEALTH_ID = {result.value:.2f} ({result.category})")

        # 3. Расчёт baseline
        print()
        print("=== РАСЧЁТ BASELINE ===")
        baseline = calculate_baseline(
            session=session,
            worker_pseudonym=worker,
            current_event_id="curr_01",
            window_days=90,
        )
        print(f"  available: {baseline.available}, events: {baseline.n_historical_events}")

        # 4. Проверка отклонений
        print()
        print("=== ОТКЛОНЕНИЯ ОТ КОРРИДОРА ===")
        current_deviations = check_all_deviations(session, baseline, "curr_01")
        for dev in current_deviations:
            status = "✅" if dev.in_corridor else f"⚠️ {dev.deviation_type} ({dev.sigma:.1f}σ)"
            print(f"  {dev.feature_name:30s}  {status}")

        # 5. Классификация состояния
        print()
        print("=== КЛАССИФИКАЦИЯ СОСТОЯНИЯ ===")
        classification = classify_state(
            session=session,
            health_id_result=result,
            baseline=baseline,
            current_deviations=current_deviations,
            worker_pseudonym=worker,
            current_event_id="curr_01",
        )

        print(f"  HEALTH_ID: {classification.health_id_value:.2f} ({classification.health_id_category})")
        print(f"  Доминантный флаг: {classification.dominant_flag}")
        print()

        for flag in classification.flags:
            status = "🔴 АКТИВЕН" if flag.active else "⚪ неактивен"
            print(f"  {flag.flag:40s}  {status}")
            if flag.active and flag.evidence:
                for ev in flag.evidence:
                    print(f"    → {ev}")
            if flag.active and flag.details:
                print(f"    детали: {flag.details}")
            print()

        print("  --- Сводка ---")
        print(classification.summary)

        # 6. Применение к результату
        print()
        print("=== ЗАПИСЬ В БД ===")
        result = apply_classification_to_result(session, result, classification)
        print(f"  acute_deviation:              {result.acute_deviation}")
        print(f"  persistent_repeated_deviation: {result.persistent_repeated_deviation}")
        print(f"  confirmed_chronic:            {result.confirmed_chronic}")
        print(f"  personal_deviation:           {result.personal_deviation}")
        print(f"  personal_deviation_feature:   {result.personal_deviation_feature}")

        # 7. Проверки
        print()
        print("=== ПРОВЕРКИ ===")

        # АД 145 vs коридор ~120-126 → острое отклонение
        assert result.acute_deviation, "Должен быть acute_deviation (АД 145, ≥2σ)"
        print("  ✅ acute_deviation: АД 145 >> коридор")

        # АД повышен 3 раза за 30 дней (hist_04, hist_05, curr_01) → persistent
        assert result.persistent_repeated_deviation, "Должен быть persistent (3 отклонения за 30 дней)"
        print("  ✅ persistent_repeated_deviation: 3 отклонения АД за 30 дней")

        # АД повышен 3 раза за 90 дней, разнесены > 30 дней → chronic
        assert result.confirmed_chronic, "Должен быть confirmed_chronic (3 события за 90 дней, span > 30)"
        print("  ✅ confirmed_chronic: 3 события за 90+ дней, span > 30 дней")

        # Персональное отклонение — да (выход за персональный коридор)
        assert result.personal_deviation, "Должен быть personal_deviation"
        print("  ✅ personal_deviation: выход за персональный коридор")

        # Доминантный флаг — confirmed_chronic (наивысший приоритет)
        assert classification.dominant_flag == "confirmed_chronic"
        print("  ✅ dominant_flag: confirmed_chronic (приоритет 3)")

        print()
        print("  🎉 Все проверки пройдены!")
