"""
Конфигурация версий модели и пороговых значений.
Пороги версионируются, хранятся в config_snapshot модели.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass(frozen=True)
class ModelConfig:
    """Снимок конфигурации модели — хешируется и хранится в model_versions."""

    model_version: str = "face_v1.0.0"
    parent_version: str | None = None

    # Пороги Face Matching
    match_threshold: float = 0.85
    manual_review_threshold: float = 0.60

    # Параметры обработки видео
    max_frames_to_analyze: int = 30
    frame_sample_strategy: str = "uniform"
    min_detected_frames: int = 5

    # Параметры face embedding
    embedding_method: str = "hog_lbp"
    face_size: tuple[int, int] = (128, 128)
    face_padding: int = 20

    # Детектор лица
    detector_backend: str = "haar"
    min_face_size: int = 64
    detection_scale_factor: float = 1.1
    detection_min_neighbors: int = 5

    # Качество видео
    quality_min_resolution: tuple[int, int] = (640, 480)
    quality_min_fps: int = 15
    quality_min_duration_sec: int = 3
    quality_max_blur: float = 35.0
    quality_min_face_area_pct: float = 5.0
    quality_max_yaw: float = 25.0
    quality_max_pitch: float = 20.0
    quality_max_roll: float = 15.0
    quality_max_occlusion_pct: float = 10.0
    quality_min_lighting: float = 60.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), sort_keys=True, ensure_ascii=False)

    @property
    def config_hash(self) -> str:
        return hashlib.sha256(self.to_json().encode()).hexdigest()


def get_default_config() -> ModelConfig:
    return ModelConfig()


def get_config_by_version(version: str) -> ModelConfig:
    """Заглушка: в продакшене загружается из model_versions таблицы."""
    configs = {
        "face_v1.0.0": ModelConfig(model_version="face_v1.0.0"),
        "face_v1.1.0": ModelConfig(
            model_version="face_v1.1.0",
            parent_version="face_v1.0.0",
            match_threshold=0.82,
            max_frames_to_analyze=45,
        ),
    }
    if version not in configs:
        raise ValueError(f"Unknown model version: {version}")
    return configs[version]
