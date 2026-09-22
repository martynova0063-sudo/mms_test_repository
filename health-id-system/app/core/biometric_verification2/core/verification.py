"""
Главный оркестратор биометрической верификации.

Объединяет:
  - Контроль качества видео
  - Face Matching (модуль 4.1.1)
  - Маршрутизацию результата
  - Сохранение в БД и аудит
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from biometric_verification.config.settings import ModelConfig, get_default_config
from biometric_verification.core.face_detector import get_face_detector
from biometric_verification.core.face_matching import (
    run_face_matching,
    FaceMatchOutput,
    Decision,
)
from biometric_verification.core.quality_control import check_video_quality, QualityResult
from biometric_verification.core.routing import route_verification, VerificationResult


@dataclass
class VerificationOutput:
    """Полный результат верификации — агрегат всех модулей."""

    verification_id: str
    event_id: str
    worker_pseudonym: str
    model_version: str
    config_hash: str

    face_match: FaceMatchOutput
    quality: QualityResult
    route: str
    liveness_score: float = 0.0
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict[str, Any]:
        return {
            "verification_id": self.verification_id,
            "event_id": self.event_id,
            "worker_pseudonym": self.worker_pseudonym,
            "model_version": self.model_version,
            "config_hash": self.config_hash,
            "face_match": self.face_match.to_dict(),
            "quality": self.quality.to_dict(),
            "route": self.route,
            "liveness_score": self.liveness_score,
            "created_at": self.created_at,
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, default=str)


class BiometricVerifier:
    """Оркестратор верификации.

    Использование:
        verifier = BiometricVerifier()
        result = verifier.verify(
            photo_path="photos/user_001.jpg",
            video_path="videos/user_001.mp4",
            worker_pseudonym="worker_abc123",
            event_id="evt_20260918_001",
        )
    """

    def __init__(self, config: ModelConfig | None = None):
        self.config = config or get_default_config()

    def verify(
        self,
        photo_path: str,
        video_path: str,
        worker_pseudonym: str,
        event_id: str | None = None,
        db_conn=None,
        actor: str | None = None,
        actor_role: str = "operator",
        ip_address: str | None = None,
        user_agent: str | None = None,
    ) -> VerificationOutput:
        """Полный цикл верификации."""
        verification_id = str(uuid.uuid4())

        # 1. Контроль качества
        detector = get_face_detector(
            backend=self.config.detector_backend,
            scale_factor=self.config.detection_scale_factor,
            min_neighbors=self.config.detection_min_neighbors,
            min_size=self.config.min_face_size,
        )
        quality = check_video_quality(
            video_path=video_path,
            face_detector=detector,
            config=self.config,
        )

        # 2. Face Matching
        face_match = run_face_matching(
            video_path=video_path,
            reference_photo_path=photo_path,
            config=self.config,
        )

        # 3. Liveness (заглушка — модуль 4.1.2)
        if face_match.detected_frames > 0:
            liveness_score = 0.75  # placeholder
        else:
            liveness_score = 0.0

        # 4. Маршрутизация
        quality_dict = quality.to_dict()
        routing = route_verification(
            match_score=face_match.match_score,
            liveness_score=liveness_score,
            quality_result=quality_dict,
            session_id=verification_id,
            config=self.config,
        )

        status_map = {
            "verified": "verified",
            "manual_review": "manual_review",
            "not_verified": "not_verified",
        }
        db_status = status_map.get(routing.route, "not_verified")

        result = VerificationOutput(
            verification_id=verification_id,
            event_id=event_id or "",
            worker_pseudonym=worker_pseudonym,
            model_version=self.config.model_version,
            config_hash=self.config.config_hash,
            face_match=face_match,
            quality=quality,
            route=routing.route,
            liveness_score=liveness_score,
        )

        # 5. Сохранение в БД
        if db_conn is not None:
            self._save_to_db(
                conn=db_conn,
                result=result,
                db_status=db_status,
                routing=routing,
                actor=actor or worker_pseudonym,
                actor_role=actor_role,
                ip_address=ip_address,
                user_agent=user_agent,
            )

        return result

    def _save_to_db(
        self, conn, result: VerificationOutput, db_status: str,
        routing: VerificationResult, actor: str, actor_role: str,
        ip_address: str | None, user_agent: str | None,
    ) -> None:
        from biometric_verification.db.connection import (
            insert_verification, insert_audit_log,
        )

        full_result = result.to_dict()

        insert_verification(
            conn=conn,
            worker_pseudonym=result.worker_pseudonym,
            event_id=result.event_id or None,
            status=db_status,
            face_match_score=result.face_match.match_score,
            liveness_score=result.liveness_score,
            quality_score=float(
                sum(1 for c in result.quality.checks.values()
                    if c.get("status") == "pass") / max(len(result.quality.checks), 1)
            ),
            pipeline_version=result.model_version,
            config_hash=result.config_hash,
            full_result=full_result,
            verification_id=result.verification_id,
        )

        insert_audit_log(
            conn=conn,
            entity_type="verification",
            entity_id=result.verification_id,
            action="verification_completed",
            actor=actor,
            actor_role=actor_role,
            details={
                "route": result.route,
                "match_score": result.face_match.match_score,
                "decision": result.face_match.decision,
                "quality_overall": result.quality.overall,
                "liveness_score": result.liveness_score,
            },
            ip_address=ip_address,
            user_agent=user_agent,
        )
