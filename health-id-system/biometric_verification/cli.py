"""CLI для биометрической верификации."""
from __future__ import annotations
import sys, json, argparse
from .config.settings import ModelConfig
from .core.verification import BiometricVerifier
from .core.face_matching import run_face_match
from .core.liveness_detection import run_liveness_detection
from .core.quality_control import check_video_quality
from .core.rppg import run_rppg
from .core.health_id import compute_health_id
from .core.baseline import build_all_baselines, corridors_to_dict
from .core.review_tasks import generate_review_tasks
from .core.drift_detection import detect_drift
from .core.face_detector import FaceDetectorFactory
from .db.schema import init_schema, get_schema_sql
from .db.connection import insert_model_version, get_pending_review_tasks
from dataclasses import asdict

def main():
    parser = argparse.ArgumentParser(prog="biometric_verification", description="Биометрическая верификация")
    sub = parser.add_subparsers(dest="command")

    # verify
    p = sub.add_parser("verify", help="Полная верификация")
    p.add_argument("--photo", required=True)
    p.add_argument("--video", required=True)
    p.add_argument("--worker", required=True)
    p.add_argument("--event", default="")
    #p.add_argument("--dsn", default=None)

    # face-match
    p = sub.add_parser("face-match", help="Только сравнение лица")
    p.add_argument("--photo", required=True)
    p.add_argument("--video", required=True)

    # liveness-check
    p = sub.add_parser("liveness-check", help="Только liveness")
    p.add_argument("--video", required=True)

    # quality-check
    p = sub.add_parser("quality-check", help="Только качество")
    p.add_argument("--video", required=True)

    # health-id
    p = sub.add_parser("health-id", help="Только HEALTH_ID")
    p.add_argument("--video", required=True)
    p.add_argument("--worker", required=True)

    # init-db
    p = sub.add_parser("init-db", help="Инициализация БД")
    #p.add_argument("--dsn", required=True)

    # register-model
    p = sub.add_parser("register-model", help="Регистрация версии модели")
    #p.add_argument("--dsn", required=True)
    p.add_argument("--version", required=True)
    p.add_argument("--created-by", required=True)
    p.add_argument("--description", default="")

    # review-tasks
    p = sub.add_parser("review-tasks", help="Список review tasks")
    #p.add_argument("--dsn", required=True)
    p.add_argument("--limit", type=int, default=50)

    # drift
    p = sub.add_parser("drift", help="Анализ дрейфа")
    p.add_argument("--reference", required=True, help="JSON файл с reference данными")
    p.add_argument("--current", required=True, help="JSON файл с current данными")
    p.add_argument("--period-start", default="")
    p.add_argument("--period-end", default="")
    #p.add_argument("--dsn", default=None)

    # serve
    p = sub.add_parser("serve", help="Запуск API сервера")
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=8000)

    args = parser.parse_args()
    config = ModelConfig()

    if args.command == "verify":
        verifier = BiometricVerifier(config)
        db_conn = None
        if args.dsn:
            import psycopg2
            db_conn = psycopg2.connect(args.dsn)
        result = verifier.verify(args.photo, args.video, args.worker, args.event, db_conn=db_conn)
        if db_conn: db_conn.close()
        print(json.dumps(asdict(result), indent=2, default=str))

    elif args.command == "face-match":
        result = run_face_match(args.photo, args.video, config)
        print(json.dumps(asdict(result), indent=2, default=str))

    elif args.command == "liveness-check":
        result = run_liveness_detection(args.video, config)
        d = asdict(result)
        d["liveness_signals"] = {k: asdict(v) for k, v in result.liveness_signals.items()}
        print(json.dumps(d, indent=2, default=str))

    elif args.command == "quality-check":
        detector = FaceDetectorFactory.create(config.detector_backend)
        result = check_video_quality(args.video, config, detector)
        print(json.dumps(asdict(result), indent=2, default=str))

    elif args.command == "health-id":
        rppg = run_rppg(args.video, config)
        corridors = build_all_baselines([], config)
        health = compute_health_id(rppg, corridors, [], config)
        print(json.dumps(asdict(health), indent=2, default=str))

    elif args.command == "init-db":
        import psycopg2
        conn = psycopg2.connect(args.dsn)
        init_schema(conn)
        conn.close()

    elif args.command == "register-model":
        import psycopg2
        conn = psycopg2.connect(args.dsn)
        insert_model_version(conn, args.version, config.to_dict(), config.config_hash,
                              args.created_by, description=args.description)
        conn.close()
        print(f"Model version {args.version} registered.")

    elif args.command == "review-tasks":
        import psycopg2
        conn = psycopg2.connect(args.dsn)
        rows = get_pending_review_tasks(conn, args.limit)
        conn.close()
        for r in rows:
            print(f"  {r[0]} | {r[3]:7s} | {r[4]:25s} | {r[2]:10s} | {r[5]}")

    elif args.command == "drift":
        with open(args.reference) as f: ref_data = json.load(f)
        with open(args.current) as f: cur_data = json.load(f)
        report = detect_drift(ref_data, cur_data, config, config.model_version,
                              args.period_start, args.period_end)
        print(json.dumps(asdict(report), indent=2, default=str))
        if args.dsn:
            import psycopg2
            from .db.connection import insert_drift_report
            conn = psycopg2.connect(args.dsn)
            insert_drift_report(conn, report)
            conn.close()
            print("Drift report saved to DB.")

    elif args.command == "serve":
        import uvicorn
        print(f"Starting API server on {args.host}:{args.port}")
        uvicorn.run("biometric_verification.api.server:app", host=args.host, port=args.port)

    else:
        parser.print_help()

if __name__ == "__main__":
    main()
