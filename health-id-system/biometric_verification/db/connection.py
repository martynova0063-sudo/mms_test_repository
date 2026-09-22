"""CRUD операции с БД."""
from __future__ import annotations
import json, uuid
from datetime import datetime, timezone
from typing import Any
from biometric_verification.config.settings import DATABASE_URL
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker
from biometric_verification.models.verifications import Verification  # <-- Твой файл модели
from biometric_verification.utils import _to_serializable

engine=create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal=sessionmaker(autocommit=False, autoflush=False, bind=engine)

def get_db() -> Session:
    db=SessionLocal()
    try: 
        yield db
    finally:
        db.close()
    
def insert_verification(session, result):
    """Вставка через session.execute(text(...)) — правильный SQLAlchemy way."""
    
    # Нормализация quality_overall
    quality_overall = result.quality.get("overall")
    if isinstance(quality_overall, str):
        mapping = {"pass": 1.0, "warning": 0.5, "fail": 0.3}
        quality_val = mapping.get(quality_overall.lower(), 0.0)
    else:
        quality_val = float(quality_overall) if quality_overall is not None else 0.0

    status_val = getattr(result, 'status', 'not_verified')
    match_score = result.face_match.get("match_score", 0)

    # Используем время из result, если есть, иначе текущее
    created_at = result.created_at if hasattr(result, "created_at") and result.created_at else datetime.now(timezone.utc)
    processed_at = result.processed_at if hasattr(result, "processed_at") and result.processed_at else created_at

    # Безопасная сериализация full_result
    def default_serializer(obj):
        if isinstance(obj, (datetime, timezone)):
            return obj.isoformat()
        if isinstance(obj, str):
            return obj
        return str(obj)

    full_result_json = json.dumps(_to_serializable(result), default=default_serializer, ensure_ascii=False)

    session.execute(text("""
        INSERT INTO verifications (
            verification_id, worker_pseudonym, event_id, status,
            face_match_score, liveness_score, quality_score, pipeline_version,
            config_hash, created_at, processed_at, full_result
        ) VALUES (
            :verification_id, :worker_pseudonym, :event_id, :status,
            :face_match_score, :liveness_score, :quality_score, :pipeline_version,
            :config_hash, :created_at, :processed_at, :full_result
        )
    """), {
        "verification_id": result.verification_id,
        "worker_pseudonym": result.worker_pseudonym,
        "event_id": result.event_id,
        "status": status_val,
        "face_match_score": match_score,
        "liveness_score": getattr(result, "liveness_score", None),
        "quality_score": quality_val,
        "pipeline_version": getattr(result, "model_version", "unknown"),
        "config_hash": getattr(result, "config_hash", "unknown"),
        "created_at": created_at,
        "processed_at": processed_at,
        "full_result": full_result_json,
    })  
def insert_model_version(conn, version: str, config_dict: dict, config_hash: str,
                         created_by: str, change_type: str = "initial",
                         description: str = "", parent: str = None, status: str = "experimental"):
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO model_versions (version_id, model_version, parent_version, change_type,
            change_description, config_snapshot, config_hash, created_by, created_at, status)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """, (
        str(uuid.uuid4()), version, parent, change_type, description,
        json.dumps(config_dict, default=str), config_hash, created_by,
        datetime.now(timezone.utc), status,
    ))
    conn.commit()
    cur.close()

def insert_health_id_calculation(session, result, calc_id: str, corridors: dict):
    hid = result.health_id

    # 1. Проверяем, существует ли model_version
    check = session.execute(
        text("SELECT 1 FROM model_versions WHERE model_version = :mv"),
        {"mv": result.model_version}
    )
    if not check.fetchone():
        return

    # 2. Вставляем
    session.execute(text("""
        INSERT INTO health_id_calculations (
            calculation_id, worker_pseudonym, event_id,
            model_version, config_hash, health_id_value, completeness,
            uncertainty_score, is_acute, is_persistent, is_chronic,
            full_result, evidence, created_at
        ) VALUES (
            :calculation_id, :worker_pseudonym, :event_id,
            :model_version, :config_hash, :health_id_value, :completeness,
            :uncertainty_score, :is_acute, :is_persistent, :is_chronic,
            :full_result, :evidence, :created_at
        )
    """), {
        "calculation_id": calc_id,
        "worker_pseudonym": result.worker_pseudonym,
        "event_id": result.event_id,
        "model_version": result.model_version,
        "config_hash": result.config_hash,
        "health_id_value": hid.get("health_id_value", 0),
        "completeness": hid.get("completeness", 0),
        "uncertainty_score": hid.get("uncertainty_score", 0),
        "is_acute": hid.get("is_acute", False),
        "is_persistent": hid.get("is_persistent", False),
        "is_chronic": hid.get("is_chronic", False),
        "full_result": json.dumps(_to_serializable(hid), default=str),
        "evidence": json.dumps(_to_serializable(hid.get("evidence", {})), default=str),
        "created_at": datetime.now(timezone.utc),
    })
    # НЕТ commit() — коммит делает _save_to_db

def insert_review_task(conn, task):
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO review_tasks (review_id, calculation_id, status, priority, trigger,
            reviewer_id, reviewer_qualification, comment, decision_rationale,
            created_at, reviewed_at, audit_trail)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """, (
        task.review_id, task.calculation_id, task.status, task.priority, task.trigger,
        None, None, None, None, datetime.now(timezone.utc), None,
        json.dumps(_to_serializable(task.audit_trail), default=str),
    ))
    conn.commit()
    cur.close()

def update_review_task(conn, review_id: str, status: str, reviewer_id: str,
                       reviewer_qualification: str, comment: str = "",
                       decision_rationale: str = ""):
    cur = conn.cursor()
    cur.execute("""
        UPDATE review_tasks
        SET status = %s, reviewer_id = %s, reviewer_qualification = %s,
            comment = %s, decision_rationale = %s, reviewed_at = %s,
            audit_trail = audit_trail || %s::jsonb
        WHERE review_id = %s
    """, (
        status, reviewer_id, reviewer_qualification, comment, decision_rationale,
        datetime.now(timezone.utc),
        json.dumps([{"timestamp": datetime.now(timezone.utc).isoformat(),
                     "action": f"status_{status}", "reviewer_id": reviewer_id}]),
        review_id,
    ))
    conn.commit()
    cur.close()

def get_pending_review_tasks(conn, limit: int = 50):
    cur = conn.cursor()
    cur.execute("""
        SELECT review_id, calculation_id, status, priority, trigger,
               created_at, audit_trail
        FROM review_tasks
        WHERE status = 'pending'
        ORDER BY CASE priority WHEN 'urgent' THEN 0 ELSE 1 END, created_at
        LIMIT %s
    """, (limit,))
    rows = cur.fetchall()
    cur.close()
    return rows

def insert_audit_log(session, entity_type: str, entity_id: str, action: str,
                     actor: str, actor_role: str, details: dict | None = None):
    """Вставка в audit_log через session.execute — без курсоров и ручного commit."""
    
    audit_id = str(uuid.uuid4())
    ts = datetime.now(timezone.utc)
    details_json = json.dumps(details or {}, default=str, ensure_ascii=False)

    session.execute(text("""
        INSERT INTO audit_log (
            audit_id, entity_type, entity_id, action, actor,
            actor_role, timestamp, details
        ) VALUES (
            :audit_id, :entity_type, :entity_id, :action, :actor,
            :actor_role, :timestamp, :details
        )
    """), {
        "audit_id": audit_id,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "action": action,
        "actor": actor,
        "actor_role": actor_role,
        "timestamp": ts,
        "details": details_json,
    })

def insert_drift_report(conn, report):
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO drift_reports (report_id, model_version, period_start, period_end,
            metrics, alerts, created_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
    """, (
        report.report_id, report.model_version,
        report.period_start, report.period_end,
        json.dumps(_to_serializable(report.metrics), default=str),
        json.dumps(_to_serializable(report.alerts), default=str),
        datetime.now(timezone.utc),
    ))
    conn.commit()
    cur.close()

def _to_serializable(obj):
    if isinstance(obj, dict):
        return {k: _to_serializable(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_to_serializable(v) for v in obj]
    elif hasattr(obj, "__dict__"):
        return _to_serializable(obj.__dict__)
    elif isinstance(obj, (int, float, str, bool, type(None))):
        return obj
    else:
        return str(obj)
