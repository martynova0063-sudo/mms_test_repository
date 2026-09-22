"""
Модуль 4.1.1 — Face Matching.

Конвейер:
  1. Детекция лица на каждом кадре видео.
  2. Вычисление face embedding для каждого кадра с лицом.
  3. Вычисление embedding эталонной фотографии.
  4. Сравнение через косинусное сходство.
  5. Усреднение результатов по кадрам.
"""
from __future__ import annotations

import cv2
import numpy as np
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from biometric_verification.core.face_detector import (
    DetectedFace,
    get_face_detector,
)
from biometric_verification.core.face_embedding import get_embedder
from biometric_verification.config.settings import ModelConfig


class Decision(str, Enum):
    MATCH = "match"
    NO_MATCH = "no_match"
    INSUFFICIENT_QUALITY = "insufficient_quality"
    MANUAL_REVIEW = "manual_review"


@dataclass
class FaceMatchOutput:
    """Выходные данные модуля Face Matching (раздел 4.1.1)."""

    match_score: float               # [0, 1] — итоговая оценка сходства
    per_frame_scores: list[float]    # оценки по кадрам
    best_frame_id: int               # ID кадра с максимальной оценкой
    threshold: float                 # использованный порог
    decision: str                    # match / no_match / insufficient_quality / manual_review

    # Служебные поля
    total_frames: int = 0
    detected_frames: int = 0
    reference_embedding_norm: float = 0.0
    detector_backend: str = ""
    embedding_method: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "match_score": round(self.match_score, 6),
            "per_frame_scores": [round(s, 6) for s in self.per_frame_scores],
            "best_frame_id": self.best_frame_id,
            "threshold": self.threshold,
            "decision": self.decision,
            "total_frames": self.total_frames,
            "detected_frames": self.detected_frames,
            "reference_embedding_norm": round(self.reference_embedding_norm, 6),
            "detector_backend": self.detector_backend,
            "embedding_method": self.embedding_method,
        }


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Косинусное сходство в диапазоне [0, 1]."""
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    cos = float(np.dot(a, b) / (norm_a * norm_b))
    return (cos + 1.0) / 2.0


def extract_reference_embedding(
    photo_path: str,
    detector,
    embedder,
    config: ModelConfig,
) -> np.ndarray | None:
    """
    Извлечь эталонный embedding из фотографии.
    Если на фото несколько лиц — берётся самое большое.
    """
    img = cv2.imread(photo_path)
    if img is None:
        raise FileNotFoundError(f"Не удалось загрузить фото: {photo_path}")

    faces = detector.detect(img)
    if not faces:
        return None

    best_face = max(faces, key=lambda f: f.area)
    embedding = embedder.extract(img, best_face)
    return embedding


def run_face_matching(
    video_path: str,
    reference_photo_path: str,
    config: ModelConfig,
) -> FaceMatchOutput:
    """
    Полный конвейер Face Matching.

    Параметры:
        video_path: путь к видео для верификации.
        reference_photo_path: путь к эталонной фотографии.
        config: конфигурация модели (пороги, параметры детектора и эмбеддера).

    Возвращает:
        FaceMatchOutput со всеми требуемыми полями.
    """
    detector = get_face_detector(
        backend=config.detector_backend,
        scale_factor=config.detection_scale_factor,
        min_neighbors=config.detection_min_neighbors,
        min_size=config.min_face_size,
    )
    embedder = get_embedder(
        method=config.embedding_method,
        face_size=config.face_size,
        padding=config.face_padding,
    )

    # 1. Эталонный embedding
    ref_embedding = extract_reference_embedding(
        reference_photo_path, detector, embedder, config
    )
    if ref_embedding is None:
        return FaceMatchOutput(
            match_score=0.0,
            per_frame_scores=[],
            best_frame_id=-1,
            threshold=config.match_threshold,
            decision=Decision.INSUFFICIENT_QUALITY.value,
            total_frames=0,
            detected_frames=0,
            reference_embedding_norm=0.0,
            detector_backend=config.detector_backend,
            embedding_method=config.embedding_method,
        )

    # 2. Покадровый анализ видео
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Не удалось открыть видео: {video_path}")

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0

    max_frames = config.max_frames_to_analyze
    sample_interval = max(1, total_frames // max_frames)

    per_frame_scores: list[float] = []
    best_frame_id = -1
    best_score = -1.0
    detected_frames = 0
    frame_idx = 0
    analyzed_idx = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % sample_interval == 0:
            faces = detector.detect(frame)
            if faces:
                face = max(faces, key=lambda f: f.area)
                embedding = embedder.extract(frame, face)

                if embedding is not None:
                    score = cosine_similarity(embedding, ref_embedding)
                    per_frame_scores.append(score)
                    detected_frames += 1

                    if score > best_score:
                        best_score = score
                        best_frame_id = analyzed_idx

            analyzed_idx += 1

        frame_idx += 1

    cap.release()

    # 3. Усреднение и принятие решения
    if not per_frame_scores or detected_frames < config.min_detected_frames:
        return FaceMatchOutput(
            match_score=0.0,
            per_frame_scores=per_frame_scores,
            best_frame_id=best_frame_id,
            threshold=config.match_threshold,
            decision=Decision.INSUFFICIENT_QUALITY.value,
            total_frames=frame_idx,
            detected_frames=detected_frames,
            reference_embedding_norm=float(np.linalg.norm(ref_embedding)),
            detector_backend=config.detector_backend,
            embedding_method=config.embedding_method,
        )

    match_score = float(np.mean(per_frame_scores))

    if best_frame_id < 0 and per_frame_scores:
        best_frame_id = int(np.argmax(per_frame_scores))

    # 4. Решение по порогам
    if match_score >= config.match_threshold:
        decision = Decision.MATCH.value
    elif match_score >= config.manual_review_threshold:
        decision = Decision.MANUAL_REVIEW.value
    else:
        decision = Decision.NO_MATCH.value

    return FaceMatchOutput(
        match_score=match_score,
        per_frame_scores=per_frame_scores,
        best_frame_id=best_frame_id,
        threshold=config.match_threshold,
        decision=decision,
        total_frames=frame_idx,
        detected_frames=detected_frames,
        reference_embedding_norm=float(np.linalg.norm(ref_embedding)),
        detector_backend=config.detector_backend,
        embedding_method=config.embedding_method,
    )
