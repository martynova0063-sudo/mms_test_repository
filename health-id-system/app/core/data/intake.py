"""
app/core/data/intake.py

Модуль 3: Приём и контроль качества входных данных ПрМО.

Разбирает входной JSON-пакет, валидирует структуру,
прогоняет чек-лист контроля качества (раздел 6.2)
и сохраняет данные в таблицы БД.
"""

import hashlib
import json
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import (
    ExaminationEvent,
    VitalMeasurement,
    MentalAssessment,
    SocialContext,
)


# ---------------------------------------------------------------------------
# Справочник единиц измерения по признакам (для проверки unit_mismatch)
# ---------------------------------------------------------------------------

EXPECTED_UNITS = {
    "heart_rate": {"bpm"},
    "blood_pressure_systolic": {"mmHg", "mmhg"},
    "blood_pressure_diastolic": {"mmHg", "mmhg"},
    "temperature": {"°C", "c", "C"},
    "spo2": {"%"},
    "alcohol_test": {"mg/l", "mgL"},
    "adequacy_score": {"0-10"},
    "speech_coherence": {"0-10"},
    "pupil_reaction": {"0-10"},
}

# Обязательные витальные признаки
REQUIRED_VITALS = {
    "heart_rate",
    "blood_pressure_systolic",
    "blood_pressure_diastolic",
    "temperature",
    "spo2",
    "alcohol_test",
}

# Обязательные психофизиологические признаки
REQUIRED_MENTAL = {
    "adequacy_score",
    "speech_coherence",
    "pupil_reaction",
}


# ---------------------------------------------------------------------------
# Контроль качества (раздел 6.2 — чек-лист)
# ---------------------------------------------------------------------------

def run_quality_checks(payload: dict) -> dict:
    """
    Прогоняет чек-лист из раздела 6.2.

    Возвращает отчёт вида:
        {
            "overall": "pass" | "pass_with_warnings" | "fail",
            "checks": [...],
            "actionable_flags": [...],
            "exclusion_flags": [...],
        }
    """
    checks = []
    actionable_flags = []
    exclusion_flags = []

    # --- 1. Происхождение данных (origin) ---
    mis = payload.get("metadata", {}).get("mis_source", "")
    if mis == "ECOZ":
        checks.append({"name": "origin", "status": "pass", "detail": "ECOZ verified"})
    else:
        checks.append({"name": "origin", "status": "fail", "detail": f"unknown source: {mis}"})
        exclusion_flags.append("origin_fail")

    # --- 2. Целостность пакета (integrity) ---
    # В реальной системе — проверка подписи. Здесь — проверка наличия event_id и timestamp.
    event_id = payload.get("event_id")
    timestamp = payload.get("timestamp")
    if event_id and timestamp:
        checks.append({"name": "integrity", "status": "pass", "detail": "event_id + timestamp present"})
    else:
        checks.append({"name": "integrity", "status": "fail", "detail": "missing event_id or timestamp"})
        exclusion_flags.append("integrity_fail")

    # --- 3. Единицы измерения (units) ---
    unit_mismatches = []
    for v in payload.get("measurements", {}).get("vitals", []):
        name = v.get("name", "")
        unit = v.get("unit", "")
        expected = EXPECTED_UNITS.get(name)
        if expected and unit not in expected:
            unit_mismatches.append(f"{name}: expected {expected}, got {unit}")

    if not unit_mismatches:
        checks.append({"name": "units", "status": "pass", "detail": "all units valid"})
    else:
        checks.append({"name": "units", "status": "warning", "detail": "; ".join(unit_mismatches)})
        actionable_flags.append("unit_mismatch")

    # --- 4. Качество сигнала (confidence >= 0.7) ---
    low_conf = []
    for v in payload.get("measurements", {}).get("vitals", []):
        conf = v.get("confidence")
        if conf is not None and conf < 0.7:
            low_conf.append(f"{v.get('name', '?')}: confidence={conf}")

    if not low_conf:
        checks.append({"name": "quality_confidence", "status": "pass", "detail": "all confidence ≥ 0.7"})
    else:
        checks.append({"name": "quality_confidence", "status": "warning", "detail": "; ".join(low_conf)})
        actionable_flags.append("low_quality")

    # --- 5. Процент артефактов (<= 10%) ---
    high_art = []
    for v in payload.get("measurements", {}).get("vitals", []):
        art = v.get("artifact_pct")
        if art is not None and art > 10:
            high_art.append(f"{v.get('name', '?')}: artifact_pct={art}")

    if not high_art:
        checks.append({"name": "quality_artifact", "status": "pass", "detail": "all artifacts ≤ 10%"})
    else:
        checks.append({"name": "quality_artifact", "status": "warning", "detail": "; ".join(high_art)})
        actionable_flags.append("high_artifact")

    # --- 6. Полнота данных (completeness) ---
    present_vitals = {v.get("name") for v in payload.get("measurements", {}).get("vitals", [])}
    missing_vitals = REQUIRED_VITALS - present_vitals

    mental_data = payload.get("measurements", {}).get("mental", [])
    present_mental = {m.get("name") for m in mental_data} if mental_data else set()
    missing_mental = REQUIRED_MENTAL - present_mental

    all_missing = list(missing_vitals | missing_mental)

    if not all_missing:
        checks.append({"name": "completeness", "status": "pass", "detail": "all required features present"})
    else:
        checks.append({
            "name": "completeness",
            "status": "warning",
            "detail": f"missing: {', '.join(all_missing)}",
            "missing_count": len(all_missing),
            "missing": all_missing,
        })
        actionable_flags.append("incomplete")

    # --- 7. Соответствие протоколу измерений (protocol) ---
    protocol_violations = []
    for v in payload.get("measurements", {}).get("vitals", []):
        proto = v.get("measurement_protocol")
        if proto is None:
            protocol_violations.append(f"{v.get('name', '?')}: no protocol specified")

    if not protocol_violations:
        checks.append({"name": "protocol", "status": "pass", "detail": "all protocols present"})
    else:
        checks.append({"name": "protocol", "status": "warning", "detail": "; ".join(protocol_violations)})
        actionable_flags.append("protocol_violation")

    # --- 8. Временные рамки (timing) ---
    try:
        event_time = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        now = datetime.now(event_time.tzinfo) if event_time.tzinfo else datetime.now()
        age_hours = (now - event_time).total_seconds() / 3600
        if age_hours > 24:
            checks.append({"name": "timing", "status": "warning", "detail": f"event is {age_hours:.1f}h old"})
            actionable_flags.append("stale_data")
        else:
            checks.append({"name": "timing", "status": "pass", "detail": f"event age {age_hours:.1f}h"})
    except (ValueError, TypeError):
        checks.append({"name": "timing", "status": "warning", "detail": "cannot parse timestamp"})
        actionable_flags.append("stale_data")

    # --- 9. Дубликаты (dedup) — проверяется в БД, не в этом чек-листе ---
    # (проверка делается в intake_event, т.к. нужен доступ к БД)

    # --- Итог ---
    if exclusion_flags:
        overall = "fail"
    elif actionable_flags:
        overall = "pass_with_warnings"
    else:
        overall = "pass"

    return {
        "overall": overall,
        "checks": checks,
        "actionable_flags": actionable_flags,
        "exclusion_flags": exclusion_flags,
        "missing_features": all_missing,
    }


# ---------------------------------------------------------------------------
# Разбор mental — может быть список или dict
# ---------------------------------------------------------------------------

def parse_mental_data(mental_raw: Any) -> dict:
    """
    Разбирает блок measurements.mental.

    В спеке — массив: [{"name": "adequacy_score", "value": 8, ...}, ...]
    Но может прийти и как dict: {"adequacy_score": 8, ...}

    Возвращает унифицированный dict:
        {
            "adequacy_score": {"value": 8, "confidence": 0.9, "source": "measured"},
            "speech_coherence": {...},
            "pupil_reaction": {...},
        }
    """
    result = {}

    if isinstance(mental_raw, list):
        for item in mental_raw:
            name = item.get("name")
            if not name:
                continue
            result[name] = {
                "value": item.get("value"),
                "confidence": item.get("confidence"),
                "source": item.get("source", "measured"),
                "timestamp": item.get("timestamp"),
            }
    elif isinstance(mental_raw, dict):
        for name, val in mental_raw.items():
            if isinstance(val, dict):
                result[name] = {
                    "value": val.get("value"),
                    "confidence": val.get("confidence"),
                    "source": val.get("source", "measured"),
                    "timestamp": val.get("timestamp"),
                }
            else:
                result[name] = {"value": val, "confidence": None, "source": "measured"}

    return result


# ---------------------------------------------------------------------------
# Разбор context
# ---------------------------------------------------------------------------

def parse_context(context_raw: dict) -> dict:
    """
    Разбирает блок measurements.context.

    Возвращает унифицированный dict с ключами:
        workplace, shift, examination_type
    """
    return {
        "workplace": context_raw.get("workplace"),
        "shift": context_raw.get("shift"),
        "examination_type": context_raw.get("examination_type", "periodic"),
    }


# ---------------------------------------------------------------------------
# Хеширование payload
# ---------------------------------------------------------------------------

def hash_payload(payload: dict) -> str:
    """Вычисляет SHA-256 от сериализованного payload (для аудита)."""
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


# ---------------------------------------------------------------------------
# Главный пайплайн приёма
# ---------------------------------------------------------------------------

def intake_event(payload: dict, session: Session) -> ExaminationEvent:
    """
    Полный цикл приёма входного пакета ПрМО:

    1. Проверка дубликата по event_id
    2. Контроль качества (чек-лист 6.2)
    3. Создание ExaminationEvent
    4. Создание VitalMeasurement (по каждому признаку)
    5. Создание MentalAssessment
    6. Создание SocialContext
    7. Сохранение quality_report в event

    Args:
        payload:  входной JSON-пакет (dict)
        session:  SQLAlchemy-сессия

    Returns:
        ExaminationEvent — созданная запись события

    Raises:
        ValueError: если пакет провалил origin/integrity или дубликат
    """
    # --- 0. Базовые поля ---
    event_id = payload["event_id"]
    worker_pseudonym = payload["worker_pseudonym"]
    event_timestamp = datetime.fromisoformat(
        payload["timestamp"].replace("Z", "+00:00")
    )
    if event_timestamp.tzinfo:
        event_timestamp = event_timestamp.replace(tzinfo=None)

    # --- 1. Проверка дубликата ---
    existing = session.execute(
        select(ExaminationEvent).where(
            ExaminationEvent.event_id == event_id
        )
    ).scalar_one_or_none()

    if existing:
        raise ValueError(f"Дубликат event_id: {event_id} (уже существует в БД)")

    # --- 2. Контроль качества ---
    quality_report = run_quality_checks(payload)

    # Если fail — создаём запись, но помечаем (пакет не пойдёт в расчёт)
    overall = quality_report["overall"]

    # --- 3. Создание ExaminationEvent ---
    metadata = payload.get("metadata", {})

    event = ExaminationEvent(
        id=str(uuid.uuid4()),
        event_id=event_id,
        event_type=payload.get("event_type", "periodic_medical_examination"),
        worker_pseudonym=worker_pseudonym,
        timestamp=event_timestamp,
        mis_source=metadata.get("mis_source", "ECOZ"),
        transmission_id=metadata.get("transmission_id"),
        transmission_timestamp=_safe_parse_ts(metadata.get("transmission_timestamp")),
        quality_status=overall,
        quality_report=quality_report,
        raw_payload_hash=hash_payload(payload),
    )
    session.add(event)
    session.flush()  # получаем event.id

    # --- 4. VitalMeasurement (витальные показатели) ---
    vitals_raw = payload.get("measurements", {}).get("vitals", [])

    for v in vitals_raw:
        feature_name = v.get("name")
        if not feature_name:
            continue

        # Флаги качества для конкретного измерения
        conf = v.get("confidence")
        art = v.get("artifact_pct")
        unit = v.get("unit", "")
        proto = v.get("measurement_protocol")

        unit_mm = unit not in EXPECTED_UNITS.get(feature_name, set()) if feature_name in EXPECTED_UNITS else False
        low_q = (conf is not None and conf < 0.7)
        high_a = (art is not None and art > 10)
        proto_v = (proto is None)

        vital = VitalMeasurement(
            id=str(uuid.uuid4()),
            event_id=event.id,
            feature_name=feature_name,
            value=float(v["value"]),
            unit=unit,
            source=v.get("source", "measured"),
            confidence=conf,
            artifact_pct=art,
            measurement_protocol=proto,
            device_id=v.get("device_id"),
            device_model=v.get("device_model"),
            measured_at=_safe_parse_ts(v.get("timestamp")),
            unit_mismatch=unit_mm,
            low_quality=low_q,
            high_artifact=high_a,
            protocol_violation=proto_v,
        )
        session.add(vital)

    # --- 5. MentalAssessment (психофизиология) ---
    mental_raw = payload.get("measurements", {}).get("mental", [])
    mental_parsed = parse_mental_data(mental_raw)

    mental = MentalAssessment(
        id=str(uuid.uuid4()),
        event_id=event.id,
        adequacy_score=_safe_float(mental_parsed.get("adequacy_score", {}).get("value")),
        adequacy_source=mental_parsed.get("adequacy_score", {}).get("source", "measured"),
        adequacy_confidence=mental_parsed.get("adequacy_score", {}).get("confidence"),
        speech_coherence=_safe_float(mental_parsed.get("speech_coherence", {}).get("value")),
        speech_source=mental_parsed.get("speech_coherence", {}).get("source", "derived"),
        speech_confidence=mental_parsed.get("speech_coherence", {}).get("confidence"),
        pupil_reaction=_safe_float(mental_parsed.get("pupil_reaction", {}).get("value")),
        pupil_source=mental_parsed.get("pupil_reaction", {}).get("source", "measured"),
        pupil_confidence=mental_parsed.get("pupil_reaction", {}).get("confidence"),
        reviewer_notes=None,  # в входном пакете нет, появится при human review
    )
    session.add(mental)

    # --- 6. SocialContext (контекст) ---
    context_raw = payload.get("measurements", {}).get("context", {})
    context_parsed = parse_context(context_raw)

    social = SocialContext(
        id=str(uuid.uuid4()),
        event_id=event.id,
        workplace=context_parsed["workplace"],
        shift=context_parsed["shift"],
        examination_type=context_parsed["examination_type"],
        examination_regularity=None,   # рассчитывается в Модуле 4 (baseline)
        missed_examinations=None,       # рассчитывается в Модуле 4
        regularity_window_days=90,
        missed_window_days=30,
    )
    session.add(social)

    session.commit()

    # --- Отчёт ---
    _print_intake_summary(event, quality_report, len(vitals_raw), len(mental_parsed))

    return event


# ---------------------------------------------------------------------------
# Вспомогательные функции
# ---------------------------------------------------------------------------

def _safe_parse_ts(raw: str | None) -> datetime | None:
    """Безопасно парсит ISO-8601 timestamp."""
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return dt.replace(tzinfo=None) if dt.tzinfo else dt
    except (ValueError, TypeError):
        return None


def _safe_float(val: Any) -> float | None:
    """Конвертирует значение в float или None."""
    if val is None:
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def _print_intake_summary(event: ExaminationEvent, qr: dict, n_vitals: int, n_mental: int):
    """Выводит краткий отчёт о приёме пакета."""
    print(f"  ✅ Событие принято: {event.event_id}")
    print(f"     Работник: {event.worker_pseudonym}")
    print(f"     Время:    {event.timestamp}")
    print(f"     Витальные: {n_vitals}, психофизиология: {n_mental}")
    print(f"     Качество:  {qr['overall']}")
    if qr["actionable_flags"]:
        print(f"     Флаги:     {', '.join(qr['actionable_flags'])}")
    if qr["exclusion_flags"]:
        print(f"     ⛔ Исключение: {', '.join(qr['exclusion_flags'])}")
    if qr.get("missing_features"):
        print(f"     Отсутствует: {', '.join(qr['missing_features'])}")
    print()


# ---------------------------------------------------------------------------
# CLI-запуск для тестирования
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys
    from sqlalchemy import create_engine

    from app.db.models import Base

    # Тестовый пакет из раздела 6.1
    test_payload = {
        "event_id": "evt_test_001",
        "event_type": "periodic_medical_examination",
        "worker_pseudonym": "hash_worker_001",
        "timestamp": "2026-09-15T10:30:00+04:00",
        "measurements": {
            "vitals": [
                {
                    "name": "heart_rate",
                    "value": 72,
                    "unit": "bpm",
                    "device_id": "med_device_001",
                    "device_model": "ТМ-4",
                    "measurement_protocol": "standard_v2",
                    "confidence": 0.95,
                    "artifact_pct": 2,
                    "timestamp": "2026-09-15T10:29:00+04:00",
                },
                {
                    "name": "blood_pressure_systolic",
                    "value": 142,
                    "unit": "mmHg",
                    "device_id": "med_device_002",
                    "device_model": "BP-200",
                    "measurement_protocol": "standard_v2",
                    "confidence": 0.92,
                    "artifact_pct": 1,
                    "timestamp": "2026-09-15T10:29:30+04:00",
                },
                {
                    "name": "blood_pressure_diastolic",
                    "value": 88,
                    "unit": "mmHg",
                    "device_id": "med_device_002",
                    "device_model": "BP-200",
                    "measurement_protocol": "standard_v2",
                    "confidence": 0.92,
                    "artifact_pct": 1,
                    "timestamp": "2026-09-15T10:29:30+04:00",
                },
                {
                    "name": "temperature",
                    "value": 36.6,
                    "unit": "°C",
                    "device_id": "med_device_003",
                    "device_model": "ThermoPro",
                    "measurement_protocol": "standard_v2",
                    "confidence": 0.98,
                    "artifact_pct": 0,
                    "timestamp": "2026-09-15T10:28:00+04:00",
                },
                {
                    "name": "spo2",
                    "value": 98,
                    "unit": "%",
                    "device_id": "med_device_004",
                    "device_model": "Oximeter-5",
                    "measurement_protocol": "standard_v2",
                    "confidence": 0.96,
                    "artifact_pct": 0,
                    "timestamp": "2026-09-15T10:28:30+04:00",
                },
                {
                    "name": "alcohol_test",
                    "value": 0.00,
                    "unit": "mg/l",
                    "device_id": "med_device_005",
                    "device_model": "AlcoPro",
                    "measurement_protocol": "standard_v2",
                    "confidence": 0.99,
                    "artifact_pct": 0,
                    "timestamp": "2026-09-15T10:30:00+04:00",
                },
            ],
            "mental": [
                {
                    "name": "adequacy_score",
                    "value": 8,
                    "confidence": 0.9,
                    "source": "measured",
                    "timestamp": "2026-09-15T10:30:00+04:00",
                },
                {
                    "name": "pupil_reaction",
                    "value": 9,
                    "confidence": 0.85,
                    "source": "measured",
                    "timestamp": "2026-09-15T10:30:00+04:00",
                },
                # speech_coherence намеренно отсутствует — тест полноты
            ],
            "context": {
                "workplace": "plant_A",
                "shift": "morning",
                "examination_type": "periodic",
            },
        },
        "metadata": {
            "mis_source": "ECOZ",
            "transmission_id": "trans_001",
            "transmission_timestamp": "2026-09-15T10:31:00+04:00",
        },
    }

    db_url = sys.argv[1] if len(sys.argv) > 1 else "sqlite:///health_id.db"
    engine = create_engine(db_url)
    Base.metadata.create_all(engine)

    with Session(engine) as session:
        event = intake_event(test_payload, session)

        print(f"  event.id в БД: {event.id}")
        print(f"  quality_status: {event.quality_status}")

        # Проверка: должно быть warning (отсутствует speech_coherence)
        assert event.quality_status == "pass_with_warnings"
        assert "incomplete" in event.quality_report["actionable_flags"]
        assert "speech_coherence" in event.quality_report["missing_features"]

        print()
        print("  🧪 Тест пройден: speech_coherence отсутствует → warning + incomplete")
