"""
scripts/test_pipeline.py

Скрывает таблицы, загружает 6 событий (5 исторических + 1 текущее с отклонением),
вызывает /api/v1/calculate через TestClient и проверяет выходной контракт.

Запуск:
    python scripts/test_pipeline.py
"""

import sys
from datetime import datetime

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select

from app.main import app
from app.db.session import init_db
from app.db.models import Base, ExaminationEvent, SocialContext


def make_payload(event_id, ts, hr, bp_s, bp_d, temp, spo2, alc, adeq, speech, pupil):
    return {
        "event_id": event_id,
        "event_type": "periodic_medical_examination",
        "worker_pseudonym": "hash_worker_pipeline_test",
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
                "examination_regularity": 0.94,
                "missed_examinations": 1,
            },
        },
        "metadata": {
            "mis_source": "ECOZ",
            "transmission_id": f"trans_{event_id}",
            "transmission_timestamp": ts,
        },
    }


events_data = [
    ("hist_01", "2026-06-01T10:00:00+04:00", 72, 120, 78, 36.6, 98, 0.0, 8, 8, 9),
    ("hist_02", "2026-07-01T10:00:00+04:00", 74, 122, 80, 36.7, 97, 0.0, 8, 8, 9),
    ("hist_03", "2026-08-01T10:00:00+04:00", 73, 125, 82, 36.8, 97, 0.0, 8, 8, 9),
    ("hist_04", "2026-08-17T10:00:00+04:00", 75, 140, 85, 36.6, 98, 0.0, 7, 7, 8),
    ("hist_05", "2026-09-02T10:00:00+04:00", 76, 142, 86, 36.6, 98, 0.0, 7, 7, 8),
    ("curr_01", "2026-09-17T10:30:00+04:00", 75, 145, 87, 36.6, 98, 0.0, 8, 8, 9),
]


def main():
    print("=" * 70)
    print("  ТЕСТ ЕДИНОГО ПАЙПЛАЙНА /api/v1/calculate")
    print("=" * 70)

    # Инициализация
    init_db()

    client = TestClient(app)

    # --- 1. Загрузка исторических событий ---
    print("\n--- 1. Загрузка 5 исторических событий ---")
    for eid, ts, hr, bp_s, bp_d, temp, spo2, alc, adeq, speech, pupil in events_data[:5]:
        payload = make_payload(eid, ts, hr, bp_s, bp_d, temp, spo2, alc, adeq, speech, pupil)
        resp = client.post("/api/v1/calculate", json=payload)
        if resp.status_code == 200:
            data = resp.json()
            print(f"  ✅ {eid}: HEALTH_ID={data['health_id']['value']:.2f} ({data['health_id']['category']})")
        else:
            print(f"  ⚠️  {eid}: status={resp.status_code}")
            print(f"     {resp.text[:200]}")

    # --- 2. Текущее событие (с отклонением АД) ---
    print("\n--- 2. Текущее событие (АД 145 — отклонение) ---")
    eid, ts, hr, bp_s, bp_d, temp, spo2, alc, adeq, speech, pupil = events_data[5]
    payload = make_payload(eid, ts, hr, bp_s, bp_d, temp, spo2, alc, adeq, speech, pupil)

    resp = client.post("/api/v1/calculate", json=payload)

    if resp.status_code != 200:
        print(f"  ❌ Ошибка: {resp.status_code}")
        print(resp.text)
        sys.exit(1)

    data = resp.json()

    # --- 3. Проверка выходного контракта ---
    print("\n--- 3. Выходной контракт ---")
    print(f"  result_id:         {data['result_id']}")
    print(f"  event_id:          {data['event_id']}")
    print(f"  health_id:         {data['health_id']['value']} ({data['health_id']['category']})")
    print(f"  model_version:     {data['model_version']}")
    print(f"  config_hash:       {data['config_snapshot_hash'][:16]}...")
    print(f"  quality_status:    {data['quality_status']}")
    print(f"  completeness:      {data['completeness']:.0%}")
    print(f"  uncertainty:      ±{data['uncertainty']:.2f}")
    print(f"  dominant_flag:     {data['dominant_flag']}")
    print(f"  duration_ms:       {data['calculation_duration_ms']}")

    print("\n  Компоненты:")
    for comp_name in ["hBody", "hMental", "hSocial"]:
        comp = data["components"][comp_name]
        print(f"    {comp_name}: value={comp['value']:.2f}, weight={comp['weight']}, "
              f"contribution={comp['contribution']:.4f} "
              f"({comp['available_features']}/{comp['total_features']} признаков)")

    print("\n  State flags:")
    for sf in data["state_flags"]:
        status = "🔴" if sf["active"] else "⚪"
        print(f"    {status} {sf['flag']}")
        if sf.get("evidence"):
            for ev in sf["evidence"]:
                print(f"       → {ev}")

    print("\n  Evidence:")
    ev = data["evidence"]
    print(f"    formulas_applied: {len(ev['formulas_applied'])} шт.")
    if ev.get("baseline"):
        bl = ev["baseline"]
        print(f"    baseline available: {bl['available']}")
        print(f"    baseline events:    {bl['n_historical_events']}")
        print(f"    excluded_event:     {bl['excluded_event']}")

    print(f"\n  Disclaimer: {data['disclaimer']}")

    print("\n  --- Human-readable ---")
    print(data["human_readable"])

    # --- 4. Проверки ---
    print("\n--- 4. Проверки ---")

    assert data["health_id"]["value"] > 0, "HEALTH_ID должен быть > 0"
    assert data["health_id"]["value"] <= 1.0, "HEALTH_ID должен быть ≤ 1.0"
    print("  ✅ HEALTH_ID в диапазоне [0, 1]")

    assert data["completeness"] > 0, "Полнота > 0"
    print(f"  ✅ Полнота: {data['completeness']:.0%}")

    assert data["model_version"] == "health_id_v1.0.0"
    print("  ✅ Версия модели корректна")

    assert data["dominant_flag"] == "confirmed_chronic"
    print(f"  ✅ Доминантный флаг: {data['dominant_flag']}")

    assert any(sf["flag"] == "acute_deviation" and sf["active"] for sf in data["state_flags"])
    print("  ✅ acute_deviation активен")

    assert any(sf["flag"] == "persistent_repeated_deviation" and sf["active"] for sf in data["state_flags"])
    print("  ✅ persistent_repeated_deviation активен")

    assert any(sf["flag"] == "confirmed_chronic" and sf["active"] for sf in data["state_flags"])
    print("  ✅ confirmed_chronic активен")

    assert data["evidence"]["baseline"]["excluded_event"] == "curr_01"
    print("  ✅ Анти-утечка: текущее событие исключено из baseline")

    assert "не является медицинским" in data["disclaimer"].lower() or "не является" in data["disclaimer"]
    print("  ✅ Дисклеймер присутствует")

    print("\n" + "=" * 70)
    print("  🎉 ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ!")
    print("=" * 70)


if __name__ == "__main__":
    main()
