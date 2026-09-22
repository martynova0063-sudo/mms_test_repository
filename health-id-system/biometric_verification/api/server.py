"""FastAPI API для рецензента — управление review tasks, верификации, дрейф."""
from __future__ import annotations
import json, uuid
from typing import Any
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException, Query, Body, Depends, Form, File,  UploadFile
from pydantic import BaseModel, Field
from ..config.settings import ModelConfig
from ..core.verification import BiometricVerifier
from ..core.review_tasks import ReviewTask, update_review_status
from ..core.drift_detection import detect_drift, drift_report_to_dict
from ..db.connection import (get_pending_review_tasks, update_review_task,
                              insert_audit_log, insert_drift_report)
from ..db.schema import init_schema
from biometric_verification.db.connection import get_db, engine
from sqlalchemy.orm import Session
from sqlalchemy import select, text

from pathlib import Path
import os

app = FastAPI(title="Биометрическая верификация API", version="1.0.0")
_verifier = BiometricVerifier()
_config = ModelConfig()

# --- Models ---

class VerifyRequest(BaseModel):
    photo_path: str
    video_path: str
    worker_pseudonym: str
    event_id: str = ""
    history: list[dict[str, float]] = Field(default_factory=list)

class ReviewTaskAction(BaseModel):
    status: str  # "confirmed" | "rejected"
    reviewer_id: str
    reviewer_qualification: str
    comment: str = ""
    decision_rationale: str = ""

class DriftRequest(BaseModel):
    reference_data: list[dict[str, float]]
    current_data: list[dict[str, float]]
    period_start: str = ""
    period_end: str = ""
    model_version: str = ""

class InitDbRequest(BaseModel):
    dsn: str

# --- Endpoints ---


def _save_to_db(session, result, calc_id, corridors, tasks):
    from ..db.connection import insert_verification, insert_health_id_calculation, insert_review_task, insert_audit_log
    print(f"✅ Зашли в сохранение: {result.verification_id}")
    insert_verification(session, result)
    #insert_health_id_calculation(session, result, calc_id, corridors)
    #for task in tasks:  insert_review_task(session, task)
    insert_audit_log(session, "verification", result.verification_id, "verify", result.worker_pseudonym, "operator")
    print(f"✅ DB prepared: {result.verification_id}")

@app.get("/health")
async def health():
    return {"status": "ok", "version": _config.model_version}

BASE_DIR = Path(__file__).resolve().parent.parent
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)  # Создаём папку, если нет

@app.post("/verify", summary="Верификация биометрии (face match + liveness + HEALTH_ID)")
async def verify(
    photo_file: UploadFile = File(...,  description="Фото для верификации"),
    video_file: UploadFile = File(..., description="Видео (обязательно)"),
    worker_pseudonym: str = Form(..., description="Сотрудник (обязательно)"),
    event_id: str = Form("", description="Событие верификации (не обязательно)"),
    db: Session = Depends(get_db),
):
  # """Запуск полной верификации: face match + liveness + quality + HEALTH_ID + review tasks."""
    file_id = str(uuid.uuid4())
    photo_path = None
    video_path = None

    try:
        if photo_file is not None:
            photo_name = f"{file_id}_{photo_file.filename}"
            photo_path = UPLOAD_DIR / photo_name
            with open(photo_path, "wb") as f:
                f.write(await photo_file.read())
        
        video_name = f"{file_id}_{video_file.filename}"
        video_path = UPLOAD_DIR / video_name
        with open(video_path, "wb") as f:
            f.write(await video_file.read())

        result = _verifier.verify(
            photo_path=photo_path,
            video_path=video_path,
            worker_pseudonym=worker_pseudonym,
            event_id=event_id,
            history=[],
        )

        # Достаём данные из объекта result
        calc_id = getattr(result, "calc_id", None)
        corridors = getattr(result, "corridors", [])
        tasks = getattr(result, "review_tasks", [])
        
        # Передаём сразу session (db), не делаем connection()
        _save_to_db(db, result, calc_id, corridors, tasks)

        db.commit()
        return _to_jsonable(result)

    except Exception as e:
        print(f"❌ Endpoint error: {e}")
        raise HTTPException(status_code=500, detail=f"Verification failed: {str(e)}")
    finally:
        for p in [photo_path, video_path]:
            if p and p.exists():
                try:
                    p.unlink()
                except:
                    pass

@app.get("/review-tasks", summary="Список review tasks, отсортированных по приоритету.")
async def list_review_tasks(
    status: str = Query("pending", regex="^(pending|confirmed|rejected|all)$"),
    limit: int = Query(50, ge=1, le=500),
    dsn: str = Query(...),
):
   # """Список review tasks, отсортированных по приоритету."""
    try:
        import psycopg2
        conn = psycopg2.connect(dsn)
        if status == "all":
            cur = conn.cursor()
            cur.execute("""
                SELECT review_id, calculation_id, status, priority, trigger,
                       created_at, audit_trail
                FROM review_tasks
                ORDER BY CASE priority WHEN 'urgent' THEN 0 ELSE 1 END, created_at DESC
                LIMIT %s
            """, (limit,))
            rows = cur.fetchall()
            cur.close()
        else:
            rows = get_pending_review_tasks(conn, limit) if status == "pending" else _get_tasks_by_status(conn, status, limit)
        conn.close()
        return [_row_to_dict(r) for r in rows]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/review-tasks/{review_id}", summary="Детали одной review task.")
async def get_review_task(review_id: str, dsn: str = Query(...)):
  #  """Детали одной review task."""
    try:
        import psycopg2
        conn = psycopg2.connect(dsn)
        cur = conn.cursor()
        cur.execute("""
            SELECT review_id, calculation_id, status, priority, trigger,
                   reviewer_id, reviewer_qualification, comment, decision_rationale,
                   created_at, reviewed_at, audit_trail
            FROM review_tasks WHERE review_id = %s
        """, (review_id,))
        row = cur.fetchone()
        cur.close()
        conn.close()
        if not row:
            raise HTTPException(status_code=404, detail="Review task not found")
        return _detailed_row_to_dict(row)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.put("/review-tasks/{review_id}", summary="Подтвердить или отклонить review task.")
async def act_on_review_task(review_id: str, action: ReviewTaskAction, dsn: str = Query(...)):
   # """Подтвердить или отклонить review task."""
    if action.status not in ("confirmed", "rejected"):
        raise HTTPException(status_code=400, detail="status must be 'confirmed' or 'rejected'")
    try:
        import psycopg2
        conn = psycopg2.connect(dsn)
        update_review_task(conn, review_id, action.status, action.reviewer_id,
                           action.reviewer_qualification, action.comment, action.decision_rationale)
        insert_audit_log(conn, "review_task", review_id, f"review_{action.status}",
                         action.reviewer_id, "reviewer",
                         {"comment": action.comment, "rationale": action.decision_rationale})
        conn.close()
        return {"review_id": review_id, "status": action.status, "reviewer_id": action.reviewer_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/drift-analysis", summary="Анализ дрейфа данных между reference и current периодами.")
async def drift_analysis(req: DriftRequest, dsn: str | None = Query(None)):
   # """Анализ дрейфа данных между reference и current периодами."""
    try:
        report = _verifier.run_drift_analysis(
            req.reference_data, req.current_data,
            req.period_start, req.period_end, req.model_version,
        )
        if dsn:
            import psycopg2
            conn = psycopg2.connect(dsn)
            insert_drift_report(conn, report)
            conn.close()
        return _to_jsonable(report)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/verifications/{verification_id}", summary="Получить результат верификации по ID.")
async def get_verification(verification_id: str, db: Session = Depends(get_db)  # <-- Магия: сессия берется из config/settings.py
):
    #"""Получить результат верификации по ID."""
    
    try:
        # SQLAlchemy raw SQL — без psycopg2, через тот же engine из .env
        result = db.execute(text("""
            SELECT verification_id, worker_pseudonym, event_id, status,
                   face_match_score, liveness_score, quality_score,
                   pipeline_version, config_hash, created_at, processed_at,
                   full_result
            FROM verifications
            WHERE verification_id = :vid
        """), {"vid": verification_id})

        row = result.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Verification not found")
        full_result = row[11]
        if isinstance(full_result, str):
            full_result = json.loads(full_result)
        return {
            "verification_id": str(row[0]), "worker_pseudonym": row[1],
            "event_id": row[2], "status": row[3],
            "face_match_score": row[4], "liveness_score": row[5],
            "quality_score": row[6], "pipeline_version": row[7],
            "config_hash": row[8], "created_at": str(row[9]),
            "processed_at": str(row[10]) if row[10] else None,
            "full_result": row[11] if isinstance(row[11], dict) else json.loads(row[11]),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/init-db", summary="Инициализация схемы БД.")
async def init_db(req: InitDbRequest):
   # """Инициализация схемы БД."""
    try:
        import psycopg2
        conn = psycopg2.connect(req.dsn)
        init_schema(conn)
        conn.close()
        return {"status": "ok", "message": "Schema initialized"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/metrics", summary="Сводные метрики за период: верификации, review tasks, дрейф.")
async def get_metrics(dsn: str = Query(...), days: int = Query(7, ge=1, le=90)):
    #"""Сводные метрики за период: верификации, review tasks, дрейф."""
    try:
        import psycopg2
        conn = psycopg2.connect(dsn)
        cur = conn.cursor()
        # Verifications summary
        cur.execute("""
            SELECT status, COUNT(*) FROM verifications
            WHERE created_at >= NOW() - INTERVAL '%s days'
            GROUP BY status
        """, (days,))
        ver_summary = {row[0]: row[1] for row in cur.fetchall()}
        # Review tasks summary
        cur.execute("""
            SELECT status, priority, COUNT(*) FROM review_tasks
            WHERE created_at >= NOW() - INTERVAL '%s days'
            GROUP BY status, priority
        """, (days,))
        review_summary = [{"status": r[0], "priority": r[1], "count": r[2]} for r in cur.fetchall()]
        # Drift reports
        cur.execute("""
            SELECT report_id, model_version, period_start, period_end,
                   alerts->>'drift_detected' as drift_detected,
                   alerts->>'severity' as severity
            FROM drift_reports
            WHERE created_at >= NOW() - INTERVAL '%s days'
            ORDER BY created_at DESC LIMIT 10
        """, (days,))
        drift_summary = [{"report_id": str(r[0]), "model_version": r[1],
                          "period_start": str(r[2]), "period_end": str(r[3]),
                          "drift_detected": r[4], "severity": r[5]} for r in cur.fetchall()]
        cur.close()
        conn.close()
        return {"period_days": days, "verifications": ver_summary,
                "review_tasks": review_summary, "drift_reports": drift_summary}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# --- Helpers ---

def _to_jsonable(obj):
    if isinstance(obj, dict):
        return {k: _to_jsonable(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_to_jsonable(v) for v in obj]
    elif isinstance(obj, (int, float, str, bool, type(None))):
        return obj
    elif hasattr(obj, "__dict__"):
        return _to_jsonable(obj.__dict__)
    else:
        return str(obj)

def _row_to_dict(row):
    return {
        "review_id": str(row[0]), "calculation_id": str(row[1]),
        "status": row[2], "priority": row[3], "trigger": row[4],
        "created_at": str(row[5]),
        "audit_trail": row[6] if isinstance(row[6], list) else json.loads(row[6] or "[]"),
    }

def _detailed_row_to_dict(row):
    return {
        "review_id": str(row[0]), "calculation_id": str(row[1]),
        "status": row[2], "priority": row[3], "trigger": row[4],
        "reviewer_id": row[5], "reviewer_qualification": row[6],
        "comment": row[7], "decision_rationale": row[8],
        "created_at": str(row[9]), "reviewed_at": str(row[10]) if row[10] else None,
        "audit_trail": row[11] if isinstance(row[11], list) else json.loads(row[11] or "[]"),
    }

def _get_tasks_by_status(conn, status, limit):
    cur = conn.cursor()
    cur.execute("""
        SELECT review_id, calculation_id, status, priority, trigger,
               created_at, audit_trail
        FROM review_tasks
        WHERE status = %s
        ORDER BY CASE priority WHEN 'urgent' THEN 0 ELSE 1 END, created_at DESC
        LIMIT %s
    """, (status, limit))
    rows = cur.fetchall()
    cur.close()
    return rows
