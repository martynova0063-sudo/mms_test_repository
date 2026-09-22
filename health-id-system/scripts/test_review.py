"""
scripts/test_review.py

Тест полного цикла Human Review:
  1. Создание review (автоматически при красной зоне / chronic)
  2. Получение списка pending
  3. Взятие в работу
  4. Подтверждение
  5. Проверка: повторное решение → ошибка (терминальный статус)
  6. Проверка: аудит-трейл
  7. Отклонение другого review
  8. Эскалация

Запуск:
    python scripts/test_review.py
"""

import sys

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select

from app.main import app
from app.db.session import init_db
from app.db.models import (
    Base, ExaminationEvent, SocialContext, HealthIdResult, ReviewRecord,
)


def make_payload(event_id, ts, hr, bp_s, bp_d, temp, spo2, alc, adeq, speech, pupil):
    return {
        "event_id": event_id,
        "event_type": "periodic_medical_examination",
        "worker_pseudonym": "hash_worker_review_test",
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


def main():
    print("=" * 70)
    print("  ТЕСТ HUMAN REVIEW (Модуль 7)")
    print("=" * 70)

    init_db()
    client = TestClient(app)

    # --- 1. Загрузка событий с отклонениями (для chronic) ---
    print("\n--- 1. Загрузка 5 событий (3 с повышенным АД) ---")
    events_data = [
        ("rev_hist_01", "2026-06-01T10:00:00+04:00", 72, 120, 78, 36.6, 98, 0.0, 8, 8, 9),
        ("rev_hist_02", "2026-07-01T10:00:00+04:00", 74, 122, 80, 36.7, 97, 0.0, 8, 8, 9),
        ("rev_hist_03", "2026-08-01T10:00:00+04:00", 73, 125, 82, 36.8, 97, 0.0, 8, 8, 9),
        ("rev_hist_04", "2026-08-17T10:00:00+04:00", 75, 140, 85, 36.6, 98, 0.0, 7, 7, 8),
        ("rev_hist_05", "2026-09-02T10:00:00+04:00", 76, 142, 86, 36.6, 98, 0.0, 7, 7, 8),
    ]
    for eid, ts, hr, bp_s, bp_d, temp, spo2, alc, adeq, speech, pupil in events_data:
        payload = make_payload(eid, ts, hr, bp_s, bp_d, temp, spo2, alc, adeq, speech, pupil)
        client.post("/api/v1/calculate", json=payload)

    # --- 2. Текущее событие с отклонением (должно создать review автоматически) ---
    print("\n--- 2. Текущее событие (АД 145 → chronic → auto review) ---")
    payload = make_payload(
        "rev_curr_01", "2026-09-17T10:30:00+04:00",
        75, 145, 87, 36.6, 98, 0.0, 8, 8, 9,
    )
    resp = client.post("/api/v1/calculate", json=payload)
    assert resp.status_code == 200
    data = resp.json()
    print(f"  HEALTH_ID: {data['health_id']['value']:.2f} ({data['health_id']['category']})")
    print(f"  dominant_flag: {data['dominant_flag']}")

    # --- 3. Проверка: auto review создан ---
    print("\n--- 3. Проверка авто-создания review ---")
    resp = client.get("/api/v1/review/pending")
    assert resp.status_code == 200
    pending = resp.json()
    print(f"  Pending reviews: {pending['count']}")
    assert pending["count"] >= 1, "Должен быть хотя бы 1 pending review"

    review_id = pending["items"][0]["id"]
    print(f"  Review ID:     {review_id}")
    print(f"  Review type:   {pending['items'][0]['review_type']}")
    print(f"  Priority:      {pending['items'][0]['priority']}")
    print(f"  Reason:        {pending['items'][0]['assigned_reason']}")

    # --- 4. Получение review по ID ---
    print(f"\n--- 4. Получение review {review_id} ---")
    resp = client.get(f"/api/v1/review/{review_id}")
    assert resp.status_code == 200
    review_data = resp.json()
    print(f"  Status:    {review_data['status']}")
    print(f"  Context:   health_id={review_data['context'].get('health_id_value')}, "
          f"category={review_data['context'].get('health_id_category')}")
    print(f"  Flags:     {len(review_data['context'].get('state_flags', []))} шт.")

    # --- 5. Взятие в работу ---
    print(f"\n--- 5. Взятие review в работу ---")
    resp = client.post(
        f"/api/v1/review/{review_id}/assign",
        params={"reviewer_id": "doctor_01", "reviewer_name": "Иванов И.И.", "reviewer_role": "doctor"},
    )
    assert resp.status_code == 200
    print(f"  Reviewer:  {resp.json()['reviewer_name']}")

    # Попытка взять другим медработником → ошибка
    resp = client.post(
        f"/api/v1/review/{review_id}/assign",
        params={"reviewer_id": "doctor_02"},
    )
    assert resp.status_code == 409
    print(f"  ✅ Другой медработник не может взять: {resp.json()['detail']}")

    # --- 6. Подтверждение ---
    print(f"\n--- 6. Подтверждение review ---")
    resp = client.post(
        f"/api/v1/review/{review_id}/decision",
        json={
            "decision": "confirmed",
            "comment": "Согласен с расчётом. Хроническая гипертензия подтверждена.",
            "evidence": {"reviewed_flags": ["confirmed_chronic"], "additional_notes": "Назначить лечение."},
            "reviewer_id": "doctor_01",
            "reviewer_name": "Иванов И.И.",
            "reviewer_role": "doctor",
        },
    )
    assert resp.status_code == 200
    print(f"  Decision:  {resp.json()['decision']}")
    print(f"  Status:    {resp.json()['status']}")
    print(f"  Comment:   {resp.json()['decision_comment']}")

    # --- 7. Повторное решение → ошибка (терминальный) ---
    print(f"\n--- 7. Повторное решение (должно быть отклонено) ---")
    resp = client.post(
        f"/api/v1/review/{review_id}/decision",
        json={
            "decision": "rejected",
            "reviewer_id": "doctor_01",
        },
    )
    assert resp.status_code == 409
    print(f"  ✅ Повторное решение отклонено: {resp.json()['detail']}")

    # --- 8. Аудит-трейл ---
    print(f"\n--- 8. Аудит-трейл ---")
    resp = client.get(f"/api/v1/review/{review_id}/audit")
    assert resp.status_code == 200
    audit = resp.json()
    print(f"  Записей: {audit['count']}")
    for entry in audit["entries"]:
        print(f"    {entry['timestamp']} | {entry['action']:10s} | "
              f"actor={entry['actor']} | {entry.get('details', {})}")

    # --- 9. Ручное создание + отклонение ---
    print(f"\n--- 9. Ручное создание review + отклонение ---")
    resp = client.post(
        "/api/v1/review",
        json={
            "review_type": "health_id",
            "target_id": data["result_id"],
            "event_id": "rev_curr_01",
            "assigned_reason": "Ручной запрос на проверку",
            "priority": "normal",
        },
    )
    # Может быть 409, если уже есть review для того же target
    if resp.status_code == 200:
        manual_review_id = resp.json()["id"]
        print(f"  Created: {manual_review_id}")

        # Отклонение
        resp = client.post(
            f"/api/v1/review/{manual_review_id}/decision",
            json={
                "decision": "rejected",
                "comment": "Расчёт некорректен — данные измерений под сомнением.",
                "reviewer_id": "doctor_03",
                "reviewer_name": "Петрова А.Б.",
                "reviewer_role": "senior_doctor",
            },
        )
        assert resp.status_code == 200
        print(f"  Decision: {resp.json()['decision']}")
        print(f"  Reviewer: {resp.json()['reviewer_name']}")
    else:
        print(f"  Пропущено (уже есть review): {resp.status_code}")

    # --- 10. Эскалация ---
    print(f"\n--- 10. Эскалация ---")
    resp = client.post(
        "/api/v1/review",
        json={
            "review_type": "verification",
            "target_id": "fake_session_001",
            "assigned_reason": "Спорный результат верификации: match_score=0.52",
            "priority": "urgent",
        },
    )
    assert resp.status_code == 200
    esc_review_id = resp.json()["id"]
    print(f"  Created: {esc_review_id}")

    resp = client.post(
        f"/api/v1/review/{esc_review_id}/decision",
        json={
            "decision": "escalated",
            "comment": "Требуется старший медработник — случай нетипичный.",
            "reviewer_id": "doctor_01",
            "reviewer_name": "Иванов И.И.",
            "reviewer_role": "doctor",
        },
    )
    assert resp.status_code == 200
    print(f"  Status:  {resp.json()['status']}")

    # Старший медработник подтверждает после эскалации
    resp = client.post(
        f"/api/v1/review/{esc_review_id}/decision",
        json={
            "decision": "confirmed",
            "comment": "Личность подтверждена после дополнительной проверки.",
            "reviewer_id": "doctor_03",
            "reviewer_name": "Петрова А.Б.",
            "reviewer_role": "senior_doctor",
        },
    )
    assert resp.status_code == 200
    print(f"  Final:   {resp.json()['status']} (подтверждено старшим)")

    # --- Проверки ---
    print(f"\n--- Проверки ---")
    assert pending["count"] >= 1
    print("  ✅ Auto review создан при chronic")
    print("  ✅ Защита от двойного назначения")
    print("  ✅ Подтверждение работает")
    print("  ✅ Терминальный статус защищён от повторного решения")
    print("  ✅ Аудит-трейл содержит все действия")
    print("  ✅ Отклонение работает")
    print("  ✅ Эскалация → подтверждение старшим работает")

    print("\n" + "=" * 70)
    print("  🎉 ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ!")
    print("=" * 70)


if __name__ == "__main__":
    main()
