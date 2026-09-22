"""
Конфигурация модели: пороги, параметры, хеш.
"""
from __future__ import annotations
import hashlib, json, os
from dataclasses import dataclass, field, asdict
from enum import Enum
from dotenv import load_dotenv

load_dotenv()
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/biometry_health"#os.getenv("DATABASE_URL")

if not DATABASE_URL: 
    raise RuntimeError("DATABASE_URL не задан в переменных окружения .env")

class FaceMatchDecision(str, Enum):
    MATCH = "match"
    NO_MATCH = "no_match"
    MANUAL_REVIEW = "manual_review"
    INSUFFICIENT_QUALITY = "insufficient_quality"


class LivenessDecision(str, Enum):
    LIVE = "live"
    SPOOF_DETECTED = "spoof_detected"
    INCONCLUSIVE = "inconclusive"


class HealthIDCategory(str, Enum):
    GOOD = "good"
    WARNING = "warning"
    POOR = "poor"
    INSUFFICIENT_DATA = "insufficient_data"


@dataclass
class ModelConfig:
    # Face Match
    match_threshold: float = 0.85
    manual_review_threshold: float = 0.60
    max_frames_to_process: int = 120
    frame_sample_interval: int = 5
    min_detected_frames: int = 5
    embedding_method: str = "hog_lbp"
    detector_backend: str = "haar"

    # Liveness
    liveness_pass: float = 0.70
    liveness_fail: float = 0.50
    blink_weight: float = 0.35
    head_motion_weight: float = 0.30
    texture_weight: float = 0.25
    depth_weight: float = 0.10
    blink_min_count: int = 1
    blink_min_ratio: float = 0.25
    head_motion_min_frames: int = 3
    texture_lbp_threshold: float = 0.45
    texture_freq_threshold: float = 0.40
    depth_enabled: bool = False

    # Quality
    min_resolution: tuple = (640, 480)
    min_fps: int = 15
    min_duration_sec: float = 3.0
    min_face_area_pct: float = 5.0
    max_blur_variance: float = 35.0
    max_yaw: float = 25.0
    max_pitch: float = 20.0
    max_roll: float = 15.0
    max_occlusion_pct: float = 10.0

    # rPPG
    rppg_min_fps: float = 15.0
    rppg_min_duration: float = 10.0
    rppg_target_fps: int = 30
    hr_band: tuple = (0.7, 3.0)
    br_band: tuple = (0.15, 0.5)
    rppg_min_signal_quality: float = 0.3

    # HEALTH_ID
    health_id_weights: dict = field(default_factory=lambda: {
        "heart_rate": 0.25,
        "hrv": 0.20,
        "breathing_rate": 0.15,
        "stress_index": 0.15,
        "signal_quality": 0.15,
        "verification_quality": 0.10,
    })
    health_id_good: float = 0.80
    health_id_warning: float = 0.60
    acute_z_threshold: float = 2.0
    persistent_window: int = 3
    chronic_window: int = 10
    chronic_slope_pct: float = 0.02
    min_history_for_corridor: int = 5

    # Population fallback baselines
    pop_baseline: dict = field(default_factory=lambda: {
        "heart_rate": {"mean": 72.0, "std": 10.0},
        "hrv": {"mean": 45.0, "std": 12.0},
        "breathing_rate": {"mean": 16.0, "std": 3.0},
        "stress_index": {"mean": 0.35, "std": 0.15},
    })

    # Review triggers
    review_trigger_acute: bool = True
    review_trigger_poor: bool = True
    review_trigger_persistent: bool = True
    review_trigger_chronic: bool = True
    review_trigger_manual: bool = True

    # Drift detection
    drift_window_days: int = 7
    drift_psi_threshold: float = 0.25
    drift_ks_pvalue: float = 0.05
    drift_min_samples: int = 20
    drift_metrics: list = field(default_factory=lambda: [
        "match_score", "liveness_score", "quality_score",
        "heart_rate", "hrv", "breathing_rate", "stress_index", "health_id_value",
    ])

    # Model identity
    model_version: str = "face_v1.0.0"

    def to_dict(self) -> dict:
        d = asdict(self)
        d["min_resolution"] = list(d["min_resolution"])
        d["hr_band"] = list(d["hr_band"])
        d["br_band"] = list(d["br_band"])
        return d

    @property
    def config_hash(self) -> str:
        raw = json.dumps(self.to_dict(), sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(raw.encode()).hexdigest()
