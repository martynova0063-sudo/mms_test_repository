#!/usr/bin/env python3
"""
CLI для биометрической верификации.

Пример запуска:
    python -m biometric_verification.cli verify \
        --photo photos/user_001.jpg \
        --video videos/user_001.mp4 \
        --worker worker_abc123 \
        --event evt_20260918_001

    python -m biometric_verification.cli init-db \
        --dsn "postgresql://user:pass@localhost:5432/biometric"

    python -m biometric_verification.cli register-model \
        --dsn "postgresql://user:pass@localhost:5432/biometric" \
        --version face_v1.0.0 \
        --created-by admin
"""
from __future__ import annotations

import argparse
import json
import sys
import os

from biometric_verification.config.settings import get_default_config, get_config_by_version


def cmd_verify(args):
    from biometric_verification.core.verification import BiometricVerifier

    config = get_config_by_version(args.model_version) if args.model_version else get_default_config()

    db_conn = None
    if args.dsn:
        import psycopg2
        db_conn = psycopg2.connect(args.dsn)

    verifier = BiometricVerifier(config=config)
    result = verifier.verify(
        photo_path=args.photo,
        video_path=args.video,
        worker_pseudonym=args.worker,
        event_id=args.event,
        db_conn=db_conn,
        actor=args.actor or args.worker,
        actor_role=args.actor_role,
        ip_address=args.ip,
        user_agent=args.user_agent,
    )

    print(json.dumps(result.to_dict(), indent=2, ensure_ascii=False, default=str))

    if db_conn:
        db_conn.close()


def cmd_init_db(args):
    import psycopg2
    from biometric_verification.db.connection import init_schema

    conn = psycopg2.connect(args.dsn)
    init_schema(conn)
    conn.close()
    print("Схема БД создана.")


def cmd_register_model(args):
    import psycopg2
    from biometric_verification.db.connection import insert_model_version
    from biometric_verification.config.settings import get_config_by_version

    config = get_config_by_version(args.version)
    conn = psycopg2.connect(args.dsn)

    version_id = insert_model_version(
        conn=conn,
        model_version=config.model_version,
        config_snapshot=config.to_dict(),
        config_hash=config.config_hash,
        created_by=args.created_by,
        parent_version=config.parent_version,
        change_type=args.change_type or "initial",
        change_description=args.description,
        status=args.status or "production",
    )
    conn.close()
    print(f"Модель {config.model_version} зарегистрирована. version_id={version_id}")


def cmd_quality_check(args):
    from biometric_verification.core.quality_control import check_video_quality
    from biometric_verification.core.face_detector import get_face_detector
    from biometric_verification.config.settings import get_default_config

    config = get_default_config()
    detector = get_face_detector(backend=config.detector_backend)
    result = check_video_quality(args.video, face_detector=detector, config=config)
    print(json.dumps(result.to_dict(), indent=2, ensure_ascii=False, default=str))


def main():
    parser = argparse.ArgumentParser(
        prog="biometric_verification",
        description="Биометрическая верификация личности — модуль 4.1.1",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_verify = sub.add_parser("verify", help="Запустить верификацию")
    p_verify.add_argument("--photo", required=True, help="Путь к эталонной фотографии")
    p_verify.add_argument("--video", required=True, help="Путь к видео")
    p_verify.add_argument("--worker", required=True, help="Псевдоним сотрудника")
    p_verify.add_argument("--event", default=None, help="ID события")
    p_verify.add_argument("--model-version", default=None, help="Версия модели")
    p_verify.add_argument("--dsn", default=None, help="PostgreSQL DSN")
    p_verify.add_argument("--actor", default=None)
    p_verify.add_argument("--actor-role", default="operator")
    p_verify.add_argument("--ip", default=None)
    p_verify.add_argument("--user-agent", default=None)
    p_verify.set_defaults(func=cmd_verify)

    p_db = sub.add_parser("init-db", help="Создать таблицы в БД")
    p_db.add_argument("--dsn", required=True)
    p_db.set_defaults(func=cmd_init_db)

    p_model = sub.add_parser("register-model", help="Зарегистрировать версию модели")
    p_model.add_argument("--dsn", required=True)
    p_model.add_argument("--version", required=True)
    p_model.add_argument("--created-by", required=True)
    p_model.add_argument("--change-type", default="initial")
    p_model.add_argument("--description", default=None)
    p_model.add_argument("--status", default="production")
    p_model.set_defaults(func=cmd_register_model)

    p_q = sub.add_parser("quality-check", help="Проверить качество видео")
    p_q.add_argument("--video", required=True)
    p_q.set_defaults(func=cmd_quality_check)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
