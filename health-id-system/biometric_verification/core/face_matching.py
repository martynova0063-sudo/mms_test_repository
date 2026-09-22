"""Модуль 4.1.1 — Face Matching."""
from __future__ import annotations
import cv2, numpy as np
from dataclasses import dataclass, field
from typing import Any
from .face_detector import FaceDetectorFactory, FaceBox
from .face_embedding import compute_embedding, cosine_similarity
from ..config.settings import ModelConfig, FaceMatchDecision

@dataclass
class FaceMatchOutput:
    match_score: float
    per_frame_scores: list[float]
    best_frame_id: int
    threshold: float
    decision: str
    total_frames: int = 0
    detected_frames: int = 0
    reference_embedding_norm: float = 0.0
    detector_backend: str = "haar"
    embedding_method: str = "hog_lbp"

def run_face_match(photo_path: str, video_path: str,
                   config: ModelConfig) -> FaceMatchOutput:
    ref_img = cv2.imread(photo_path)
    if ref_img is None:
        return FaceMatchOutput(0.0, [], -1, config.match_threshold,
                               FaceMatchDecision.INSUFFICIENT_QUALITY.value)
    ref_gray = cv2.cvtColor(ref_img, cv2.COLOR_BGR2GRAY)
    detector = FaceDetectorFactory.create(config.detector_backend)
    ref_faces = detector.detect(ref_img)
    if ref_faces:
        f = ref_faces[0]
        ref_crop = ref_gray[f.y:f.y+f.h, f.x:f.x+f.w]
    else:
        ref_crop = ref_gray
    ref_emb = compute_embedding(ref_crop)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return FaceMatchOutput(0.0, [], -1, config.match_threshold,
                               FaceMatchDecision.INSUFFICIENT_QUALITY.value)

    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    sample_interval = max(1, int(fps * config.frame_sample_interval / 30))

    per_frame_scores = []
    frame_id = 0
    processed = 0

    while frame_id < frame_count and processed < config.max_frames_to_process:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_id % sample_interval == 0:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = detector.detect(frame)
            if faces:
                face = max(faces, key=lambda f: f.w * f.h)
                crop = gray[face.y:face.y+face.h, face.x:face.x+face.w]
                if crop.size > 0:
                    emb = compute_embedding(crop)
                    score = cosine_similarity(ref_emb, emb)
                    per_frame_scores.append(score)
                    processed += 1
        frame_id += 1

    cap.release()

    detected = len(per_frame_scores)
    if detected < config.min_detected_frames:
        return FaceMatchOutput(
            match_score=0.0,
            per_frame_scores=per_frame_scores,
            best_frame_id=per_frame_scores.index(max(per_frame_scores)) if per_frame_scores else -1,
            threshold=config.match_threshold,
            decision=FaceMatchDecision.INSUFFICIENT_QUALITY.value,
            total_frames=frame_count, detected_frames=detected,
            reference_embedding_norm=float(np.linalg.norm(ref_emb)),
            detector_backend=config.detector_backend,
            embedding_method=config.embedding_method,
        )

    best_id = per_frame_scores.index(max(per_frame_scores))
    avg_score = float(np.mean(per_frame_scores))

    if avg_score >= config.match_threshold:
        decision = FaceMatchDecision.MATCH.value
    elif avg_score >= config.manual_review_threshold:
        decision = FaceMatchDecision.MANUAL_REVIEW.value
    else:
        decision = FaceMatchDecision.NO_MATCH.value

    return FaceMatchOutput(
        match_score=avg_score, per_frame_scores=per_frame_scores,
        best_frame_id=best_id, threshold=config.match_threshold,
        decision=decision, total_frames=frame_count, detected_frames=detected,
        reference_embedding_norm=float(np.linalg.norm(ref_emb)),
        detector_backend=config.detector_backend,
        embedding_method=config.embedding_method,
    )
