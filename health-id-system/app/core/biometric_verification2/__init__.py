"""Ядро биометрической верификации."""
from biometric_verification.core.verification import BiometricVerifier, VerificationOutput
from biometric_verification.core.face_matching import FaceMatchOutput, run_face_matching, Decision
from biometric_verification.core.quality_control import check_video_quality, QualityResult
from biometric_verification.core.routing import route_verification, VerificationResult

__all__ = [
    "BiometricVerifier", "VerificationOutput",
    "FaceMatchOutput", "run_face_matching", "Decision",
    "check_video_quality", "QualityResult",
    "route_verification", "VerificationResult",
]
