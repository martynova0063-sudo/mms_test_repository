"""Оркестратор — BiometricVerifier."""
from __future__ import annotations
import uuid, json, dataclasses
from dataclasses import dataclass, field, asdict
from typing import Any
from datetime import datetime, timezone
from ..config.settings import ModelConfig
from .face_matching import run_face_match, FaceMatchOutput
from .liveness_detection import run_liveness_detection, LivenessOutput
from .quality_control import check_video_quality, QualityResult
from .routing import route_verification, VerificationResult
from .rppg import run_rppg, RPPGOutput
from .baseline import build_all_baselines, corridors_to_dict
from .health_id import compute_health_id, HealthIDOutput
from .review_tasks import generate_review_tasks, ReviewTask
from .drift_detection import detect_drift, DriftReport
from .face_detector import FaceDetectorFactory

def _to_serializable(obj):
    if dataclasses.is_dataclass(obj):
        return dataclasses.asdict(obj)
    if isinstance(obj, dict):
        return {k: _to_serializable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_to_serializable(i) for i in obj]
    if isinstance(obj, datetime):
        return obj.isoformat()
    if hasattr(obj, "__dict__"):
        return {k: _to_serializable(v) for k, v in obj.__dict__.items()}
    return obj

@dataclass
class FullVerificationResult:
    verification_id: str
    event_id: str
    worker_pseudonym: str
    model_version: str
    config_hash: str
    face_match: dict
    liveness: dict
    quality: dict
    route: str
    liveness_score: float = 0.0
    health_id: dict = field(default_factory=dict)
    review_tasks: list[dict] = field(default_factory=list)

class BiometricVerifier:
    def __init__(self, config: ModelConfig | None = None):
        self.config = config or ModelConfig()

    def verify(self, photo_path: str, video_path: str,
               worker_pseudonym: str, event_id: str = "",
               history: list[dict[str, float]] | None = None,
               db_conn: Any = None) -> FullVerificationResult:
        vid = str(uuid.uuid4())
        history = history or []

        # 1. Quality
        detector = FaceDetectorFactory.create(self.config.detector_backend)
        quality = check_video_quality(video_path, self.config, detector)
        quality_dict = {"overall": quality.overall, "checks": quality.checks,
                        "blocking_issues": quality.blocking_issues, "warnings": quality.warnings}

        # 2. Face match
        face_match = run_face_match(photo_path, video_path, self.config)

        # 3. Liveness
        liveness = run_liveness_detection(video_path, self.config)

        # 4. Routing
        session_id = f"{worker_pseudonym}_{event_id}_{vid}"
        routing = route_verification(face_match.match_score, liveness.liveness_score,
                                      quality_dict, session_id, self.config)

        # 5. rPPG + HEALTH_ID
        rppg = run_rppg(video_path, self.config)
        corridors = build_all_baselines(history, self.config)
        ver_quality = 1.0 if quality.overall == "pass" else (0.5 if quality.overall == "warning" else 0.3)
        health_id = compute_health_id(rppg, corridors, history, self.config, ver_quality)

        # 6. Review tasks
        calc_id = str(uuid.uuid4())
        tasks = generate_review_tasks(calc_id, health_id, face_match.match_score,
                                      liveness.liveness_score, routing.route, self.config)

        # Build result
        result = FullVerificationResult(
            verification_id=vid, event_id=event_id, worker_pseudonym=worker_pseudonym,
            model_version=self.config.model_version, config_hash=self.config.config_hash,
            face_match=asdict(face_match),
            liveness={"liveness_score": liveness.liveness_score, "decision": liveness.decision,
                      "liveness_signals": {k: asdict(v) for k, v in liveness.liveness_signals.items()},
                      "evidence_frames": liveness.evidence_frames, "attack_type": liveness.attack_type},
            quality=quality_dict, route=routing.route,
            liveness_score=liveness.liveness_score,
            health_id=asdict(health_id),
            review_tasks=[asdict(t) for t in tasks],
        )

        # DB
        if db_conn is not None:
            self._save_to_db(db_conn, result, calc_id, corridors, tasks)

        return result


    def _save_to_db(self, conn, result, calc_id, corridors, tasks):
        from ..db.connection import insert_verification, insert_health_id_calculation, insert_review_task, insert_audit_log

        # Только вставки, без commit/rollback
        insert_verification(conn, result)
        insert_health_id_calculation(conn, result, calc_id, corridors)
        for task in tasks: insert_review_task(conn, task)
        insert_audit_log(conn, "verification", result.verification_id, "verify", result.worker_pseudonym, "operator")
        print(f"✅ DB prepared: {result.verification_id}")

   
    def run_drift_analysis(self, reference_data: list[dict], current_data: list[dict],
                           period_start: str = "", period_end: str = "",
                           model_version: str = "") -> DriftReport:
        return detect_drift(reference_data, current_data, self.config,
                            model_version or self.config.model_version,
                            period_start, period_end)
