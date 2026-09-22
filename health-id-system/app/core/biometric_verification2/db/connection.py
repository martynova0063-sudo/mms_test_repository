"""
Подключение к БД и операции с верификациями.
Поддерживает синхронный (psycopg2) режим.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

from biometric_verification.db.schema import SCHEMA_DDL


def init_schema(conn) -> None:
    """Создать все таблицы, если их ещё нет."""
    with conn.cursor() as cur:
        cur.execute(SCHEMA_DDL)
    conn.commit()


def insert_model_version(
    conn,
    model_version: str,
    config_snapshot: dict[str, Any],
    config_hash: str,
    created_by: str,
    parent_version: str | None = None,
    change_type: str = "initial",
    change_description: str | None = None,
    status: str = "production",
) -> str:
    """Зарегистрировать новую версию модели. Возвращает version_id (UUID)."""
    version_id = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO model_versions (
                version_id, model_version, parent_version,
                change_type, change_description,
                config_snapshot, config_hash,
                created_by, status
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (model_version) DO NOTHING
            RETURNING version_id
            """,
            (version_id, model_version, parent_version,
             change_type, change_description,
             json.dumps(config_snapshot), config_hash,
             created_by, status),
        )
        row = cur.fetchone()
        if row:
            version_id = str(row[0])
    conn.commit()
    return version_id


def insert_verification(
    conn,
    worker_pseudonym: str,
    event_id: str | None,
    status: str,
    face_match_score: float | None,
    liveness_score: float | None,
    quality_score: float | None,
    pipeline_version: str,
    config_hash: str,
    full_result: dict[str, Any],
    verification_id: str | None = None,
) -> str:
    """Сохранить результат верификации. Возвращает verification_id (UUID)."""
    vid = verification_id or str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO verifications (
                verification_id, worker_pseudonym, event_id, status,
                face_match_score, liveness_score, quality_score,
                pipeline_version, config_hash,
                created_at, processed_at, full_result
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, NOW(), NOW(), %s)
            RETURNING verification_id
            """,
            (vid, worker_pseudonym, event_id, status,
             face_match_score, liveness_score, quality_score,
             pipeline_version, config_hash,
             json.dumps(full_result)),
        )
        row = cur.fetchone()
        if row:
            vid = str(row[0])
    conn.commit()
    return vid


def insert_audit_log(
    conn,
    entity_type: str,
    entity_id: str,
    action: str,
    actor: str,
    actor_role: str,
    details: dict[str, Any] | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
) -> str:
    """Записать событие в журнал аудита."""
    audit_id = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO audit_log (
                audit_id, entity_type, entity_id,
                action, actor, actor_role,
                details, ip_address, user_agent
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (audit_id, entity_type, entity_id,
             action, actor, actor_role,
             json.dumps(details) if details else None,
             ip_address, user_agent),
        )
    conn.commit()
    return audit_id


def get_model_version_config(conn, model_version: str) -> dict[str, Any]:
    """Получить config_snapshot из model_versions по имени версии."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT config_snapshot, config_hash FROM model_versions WHERE model_version = %s",
            (model_version,),
        )
        row = cur.fetchone()
        if not row:
            raise ValueError(f"Модель {model_version} не найдена в model_versions")
        config_dict = row[0]
        config_hash = row[1]
        if isinstance(config_dict, str):
            config_dict = json.loads(config_dict)
        return config_dict, config_hash


def create_review_task(
    conn,
    calculation_id: str,
    trigger: str,
    priority: str = "routine",
    reviewer_id: str | None = None,
    reviewer_qualification: str | None = None,
    comment: str | None = None,
) -> str:
    """Создать задачу ручного пересмотра."""
    review_id = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO review_tasks (
                review_id, calculation_id, status,
                priority, trigger, reviewer_id,
                reviewer_qualification, comment
            ) VALUES (%s, %s, 'pending', %s, %s, %s, %s, %s)
            """,
            (review_id, calculation_id, priority, trigger,
             reviewer_id, reviewer_qualification, comment),
        )
    conn.commit()
    return review_id
