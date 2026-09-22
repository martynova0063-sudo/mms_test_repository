"""Биометрическая верификация личности."""
from .config.settings import ModelConfig
from .core.verification import BiometricVerifier, FullVerificationResult
from .core.face_matching import FaceMatchOutput
from .core.liveness_detection import LivenessOutput
from .core.health_id import HealthIDOutput
from .core.review_tasks import ReviewTask
from .core.drift_detection import DriftReport, detect_drift

__version__ = "1.0.0"
__all__ = [
    "ModelConfig", "BiometricVerifier", "FullVerificationResult",
    "FaceMatchOutput", "LivenessOutput", "HealthIDOutput", "ReviewTask",
    "DriftReport", "detect_drift",
]
