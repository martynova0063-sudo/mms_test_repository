"""
scripts/test_governance.py

Тест Model Governance:
  1. Инициализация версии по умолчанию
  2. Проверка: версия опубликована
  3. Запуск R0 (воспроизводимость)
  4. Запуск R1 (метрики на пилоте)
  5. Загрузка данных с дрейфом
  6. Детекция дрейфа
  7. Разрешение дрейфа
  8. Создание и депрекация новой версии

Запуск:
    python scripts/test_governance.py
"""

import sys

from fastapi.testclient import TestClient
from datetime import datetime, timedelta

from app.main import app
from app.db.session import init_db, SessionLocal
from app.db.models import Base, ExaminationEvent, SocialContext
from app.core.governance.version_service import init_default_version


def make_payload(event_id, ts, hr, bp_s, bp_d, temp, spo2, alc, adeq, speech, pupil,
                 worker="hash_worker_gov_test"):
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
                "workplace": "plant_A", "shift": "morning",
                "examination_type": "periodic",
                "examination_regularity": 0.94, "missed_examinations": 1,
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
    print("  ТЕСТ MODEL GOVERNANCE (Модуль 8)")
    print("=" * 70)

    init_db()

    # Инициализация версии по умолчанию
    with SessionLocal() as session:
        version = init_default_version(session)
        print(f"\n--- Версия по умолчанию: {version.id} ({version.status}) ---")

    client = TestClient(app)

    # --- 1. Проверка версии через API ---
    print("\n--- 1. Проверка версии через API ---")
    resp = client.get("/api/v1/governance/versions")
    assert resp.status_code == 200
    versions = resp.json()
    print(f"  Всего версий: {len(versions)}")
    for v in versions:
        print(f"    {v['id']}: status={v['status']}, hash={v['config_hash'][:16]}...")
    assert any(v["id"] == "health_id_v1.0.0" for v in versions)

    resp = client.get("/api/v1/governance/versions/active")
    assert resp.status_code == 200
    active = resp.json()
    assert active["id"] == "health_id_v1.0.0"
    assert active["status"] == "published"
    print(f"  ✅ Активная версия: {active['id']} ({active['status']})")

    # --- 2. Загрузка данных (2 периода: нормальный + дрейф) ---
    print("\n--- 2. Загрузка данных ---")

    # Reference период: 20-40 дней назад, нормальные значения
    now = datetime.utcnow()
    ref_events = []
    #for i in range(15):
    #    ts = (now - timedelta(days=35 - i)).isoformat()
    #    eid = f"gov_ref_{i:03d}"
    #    ref_events.append((eid, ts, 72, 120, 78, 36.6, 98, 0.0, 8, 8, 9))
    # Reference период: 15 событий в окне [now-27, now-7)
    for i in range(15):
        ts = (now - timedelta(days=26 - i)).isoformat()
        eid = f"gov_ref_{i:03d}"
        ref_events.append((eid, ts, 72, 120, 78, 36.6, 98, 0.0, 8, 8, 9))
    # Current период: последние 7 дней, дрейф по ЧСС (90 вместо 72)
    cur_events = []
   # for i in range(15):
    #    ts = (now - timedelta(days=6 - i)).isoformat()
      #  eid = f"gov_cur_{i:03d}"
      #  cur_events.append((eid, ts, 90, 120, 78, 36.6, 98, 0.0, 8, 8, 9))
    # Current период: 15 событий в окне [now-7, now)  
    for i in range(15):
        ts = (now - timedelta(hours=(15 - i) * 8)).isoformat()
        eid = f"gov_cur_{i:03d}"
        cur_events.append((eid, ts, 90, 120, 78, 36.6, 98, 0.0, 8, 8, 9))
    # Current период: 15 событий в окне [now-7, now)
    all_events = ref_events + cur_events
    loaded = 0
    for eid, ts, hr, bp_s, bp_d, temp, spo2, alc, adeq, speech, pupil in all_events:
        payload = make_payload(eid, ts, hr, bp_s, bp_d, temp, spo2, alc, adeq, speech, pupil)
        resp = client.post("/api/v1/calculate", json=payload)
        if resp.status_code == 200:
            loaded += 1
    print(f"  Загружено и рассчитано: {loaded}/{len(all_events)} событий")

    # --- 3. R0: Воспроизводимость ---
    print("\n--- 3. R0: Аналитическая валидация ---")
    resp = client.post(
        "/api/v1/governance/validation/r0",
        params={"model_version_id": "health_id_v1.0.0"},
    )
    assert resp.status_code == 200
    r0 = resp.json()
    print(f"  Status:  {r0['status']}")
    print(f"  Summary: {r0['summary']}")
    print(f"  Score:   {r0['reproducibility_score']}")
    assert r0["status"] == "passed"
    assert r0["reproducibility_score"] == 1.0
    print(f"  ✅ R0 пройдена: воспроизводимость 100%")

    # --- 4. R1: Метрики на пилоте ---
    print("\n--- 4. R1: Ретроспективная валидация ---")
    resp = client.post(
        "/api/v1/governance/validation/r1",
        params={"model_version_id": "health_id_v1.0.0"},
    )
    assert resp.status_code == 200
    r1 = resp.json()
    print(f"  Status:  {r1['status']}")
    print(f"  Summary: {r1['summary']}")
    print(f"  Samples: {r1['n_samples']}, Workers: {r1['n_workers']}")
    metrics = r1["metrics"]
    print(f"  Distribution: {metrics['category_distribution']}")
    print(f"  Completeness: {metrics['completeness_avg']:.1%}")
    print(f"  Flags: {metrics['flags']}")
    assert r1["status"] == "passed"
    assert r1["n_samples"] >= 10
    print(f"  ✅ R1 пройдена: {r1['n_samples']} результатов, {r1['n_workers']} работников")

    # --- 5. Детекция дрейфа ---
    print("\n--- 5. Детекция дрейфа ---")
    resp = client.post(
        "/api/v1/governance/drift/detect",
        params={
            "model_version_id": "health_id_v1.0.0",
            "reference_days": 20,
            "current_days": 7,
        },
    )
    assert resp.status_code == 200
    drifts = resp.json()
    print(f"  Обнаружено дрейфов: {len(drifts)}")
    for d in drifts:
        print(f"    {d['drift_type']:20s} {d['feature_name'] or '-':25s} "
              f"severity={d['severity']:8s} p={d['p_value']:.4f}")
        print(f"    {d['description']}")
        print(f"    → {d['recommended_action']}")

    # Дрейф по ЧСС должен быть обнаружен (72 → 90)
    hr_drift = next(
        (d for d in drifts if d["feature_name"] == "heart_rate"), None
    )
    assert hr_drift is not None, "Дрейф по ЧСС должен быть обнаружен"
    assert hr_drift["p_value"] < 0.05
    print(f"\n  ✅ Дрейф ЧСС обнаружен: {hr_drift['description']}")

    # --- 6. Разрешение дрейфа ---
    print("\n--- 6. Разрешение дрейфа ---")
    resp = client.post(
        f"/api/v1/governance/drift/{hr_drift['id']}/resolve",
        params={"resolved_by": "admin_01"},
    )
    assert resp.status_code == 200
    resolved = resp.json()
    assert resolved["resolved"] is True
    print(f"  ✅ Дрейф {hr_drift['id'][:8]}... разрешён")

    # --- 7. Список отчётов валидации ---
    print("\n--- 7. Список отчётов валидации ---")
    resp = client.get("/api/v1/governance/validation")
    assert resp.status_code == 200
    reports = resp.json()
    print(f"  Всего отчётов: {len(reports)}")
    for r in reports:
        print(f"    {r['stage']}: status={r['status']}, samples={r['n_samples']}")

    # --- 8. Создание и депрекация новой версии ---
    print("\n--- 8. Создание новой версии ---")
    new_config = """
model_version: "health_id_v1.1.0"
status: "research"
description: "Тестовая версия с изменёнными весами"

components:
  hBody:
    weight: 0.55
    features:
      - name: "heart_rate"
        unit: "bpm"
        source: "measured"
        normal_range: [60, 90]
        quality_thresholds:
          min_confidence: 0.8
          max_artifact_pct: 5
        formula: "normalized_score"
        contribution_weight: 0.30
      - name: "blood_pressure_systolic"
        unit: "mmHg"
        source: "measured"
        normal_range: [100, 130]
        formula: "normalized_score"
        contribution_weight: 0.25
      - name: "blood_pressure_diastolic"
        unit: "mmHg"
        source: "measured"
        normal_range: [60, 85]
        formula: "normalized_score"
        contribution_weight: 0.20
      - name: "temperature"
        unit: "°C"
        source: "measured"
        normal_range: [36.1, 37.2]
        formula: "normalized_score"
        contribution_weight: 0.10
      - name: "spo2"
        unit: "%"
        source: "measured"
        normal_range: [95, 100]
        formula: "normalized_score"
        contribution_weight: 0.10
      - name: "alcohol_test"
        unit: "mg/l"
        source: "measured"
        normal_range: [0, 0.15]
        formula: "binary_penalty"
        threshold: 0.16
        contribution_weight: 0.05
  hMental:
    weight: 0.30
    features:
      - name: "adequacy_score"
        unit: "0-10"
        source: "measured"
        normal_range: [7, 10]
        formula: "normalized_score"
        contribution_weight: 0.40
      - name: "speech_coherence"
        unit: "0-10"
        source: "derived"
        normal_range: [7, 10]
        formula: "normalized_score"
        contribution_weight: 0.35
      - name: "pupil_reaction"
        unit: "0-10"
        source: "measured"
        normal_range: [7, 10]
        formula: "normalized_score"
        contribution_weight: 0.25
  hSocial:
    weight: 0.15
    features:
      - name: "examination_regularity"
        unit: "ratio"
        source: "context"
        formula: "compliance_ratio"
        contribution_weight: 0.50
      - name: "missed_examinations"
        unit: "count"
        source: "context"
        formula: "penalty_function"
        contribution_weight: 0.50

thresholds:
  green: [0.80, 1.00]
  yellow: [0.60, 0.80]
  red: [0.00, 0.60]

uncertainty:
  min_completeness: 0.70
  partial_result: true
"""

    resp = client.post(
        "/api/v1/governance/versions",
        json={
            "version_id": "health_id_v1.1.0",
            "config_yaml": new_config,
            "description": "Тестовая версия с изменёнными весами (hBody 0.55, hMental 0.30)",
        },
    )
    assert resp.status_code == 200
    new_version = resp.json()
    assert new_version["status"] == "draft"
    print(f"  ✅ Создана: {new_version['id']} ({new_version['status']})")

    # Публикация
    resp = client.post("/api/v1/governance/versions/health_id_v1.1.0/publish")
    assert resp.status_code == 200
    published = resp.json()
    assert published["status"] == "published"
    print(f"  ✅ Опубликована: {published['id']} ({published['status']})")

    # Депрекация
    resp = client.post(
        "/api/v1/governance/versions/health_id_v1.1.0/deprecate",
        params={"reason": "Тестовая версия, откат к v1.0.0"},
    )
    assert resp.status_code == 200
    deprecated = resp.json()
    assert deprecated["status"] == "deprecated"
    print(f"  �А Депрекирована: {deprecated['id']} ({deprecated['status']})")

    # Проверка: попытка создать дубликат
    resp = client.post(
        "/api/v1/governance/versions",
        json={
            "version_id": "health_id_v1.0.0",
            "config_yaml": new_config,
        },
    )
    assert resp.status_code == 409
    print(f"  ✅ Дубликат отклонён: {resp.json()['detail']}")

    # --- Проверки ---
    print("\n--- Проверки ---")
    print("  ✅ Версия по умолчанию инициализирована и опубликована")
    print("  ✅ R0: воспроизводимость 100%")
    print("  ✅ R1: метрики на пилоте рассчитаны")
    print("  ✅ Дрейф ЧСС обнаружен (72→90, p<0.05)")
    print("  ✅ Разрешение дрейфа работает")
    print("  ✅ Создание/публикация/депрекация версий работает")
    print("  ✅ Дубликат версии отклонён")

    print("\n" + "=" * 70)
    print("  🎉 ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ!")
    print("=" * 70)


if __name__ == "__main__":
    main()
