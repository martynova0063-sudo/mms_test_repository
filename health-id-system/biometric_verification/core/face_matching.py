"""Модуль 4.1.1 — Face Matching."""
from __future__ import annotations
import cv2, numpy as np
from dataclasses import dataclass, field
from typing import Any, Optional
from .face_detector import FaceDetectorFactory, FaceBox
from .face_embedding import compute_embedding, cosine_similarity
from ..config.settings import ModelConfig, FaceMatchDecision
from typing import List, Optional

@dataclass
class FaceBox:
    x: int
    y: int
    w: int
    h: int
    score: float = 0.0
    # остальные поля (yaw, pitch, roll, occluded) — по необходимости
    yaw: float = 0.0
    pitch: float = 0.0
    roll: float = 0.0
    occluded: bool = False

@dataclass
class FrameFaceContext:
    """Контекст лица на конкретном кадре — передаётся в liveness и rPPG."""
    #frame_index: int
    #frame: np.ndarray
    #face_crop: Optional[np.ndarray]
    #face_box: Optional[FaceBox] = None      # главное лицо (для face matching)
    #faces: List[FaceBox] = field(default_factory=list)  # ВСЕ лица на кадре (для multi-face, occlusion и т.п.)
    #is_valid: bool = False                  # есть ли главное лицо
    #embedding: Optional[np.ndarray] = None
    #skip_reason: str = ""
    #match_score: float = 0.0

    frame_index: int
    frame: np.ndarray
    face_box: Optional[FaceBox]
    face_crop: Optional[np.ndarray]
    faces: list = field(default_factory=list)       # <-- добавить
    is_valid: bool = True
    skip_reason: str = ""
    match_score: float = 0.0


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
    detector_backend: str = ""
    embedding_method: str = ""
    skipped_multi_face_frames: int = 0
    multi_face_ratio: float = 0.0


def _select_face(
    faces: list[FaceBox],
    frame_gray: np.ndarray,
    ref_emb: np.ndarray,
    strategy: str,
    max_faces: int,
) -> tuple[Optional[FaceBox], Optional[np.ndarray], float, str]:
    """
    Возвращает (face_box, face_crop, score, skip_reason).
    """
    if len(faces) == 0:
        return None, None, 0.0, "no_face"

    if len(faces) == 1:
        f = faces[0]
        crop = frame_gray[f.y:f.y + f.h, f.x:f.x + f.w]
        if crop.size == 0:
            return None, None, 0.0, "empty_crop"
        emb = compute_embedding(crop)
        score = cosine_similarity(ref_emb, emb)
        return f, crop, score, ""

    if len(faces) > max_faces:
        if strategy == "skip_frame":
            return None, None, 0.0, "multi_face"

        if strategy == "select_closest_to_reference":
            best_box = None
            best_crop = None
            best_score = -1.0
            for f in faces:
                crop = frame_gray[f.y:f.y + f.h, f.x:f.x + f.w]
                if crop.size == 0:
                    continue
                emb = compute_embedding(crop)
                score = cosine_similarity(ref_emb, emb)
                if score > best_score:
                    best_score = score
                    best_box = f
                    best_crop = crop
            if best_box is not None:
                return best_box, best_crop, best_score, ""
            return None, None, 0.0, "all_crops_empty"

        if strategy == "max":
            best_face = max(faces, key=lambda f: f.w * f.h)
            crop = frame_gray[best_face.y:best_face.y + best_face.h,
                              best_face.x:best_face.x + best_face.w]
            if crop.size == 0:
                return None, None, 0.0, "empty_crop"
            emb = compute_embedding(crop)
            score = cosine_similarity(ref_emb, emb)
            return best_face, crop, score, ""

    if strategy == "max":
        best_face = max(faces, key=lambda f: f.w * f.h)
        crop = frame_gray[best_face.y:best_face.y + best_face.h,
                          best_face.x:best_face.x + best_face.w]
        if crop.size == 0:
            return None, None, 0.0, "empty_crop"
        emb = compute_embedding(crop)
        score = cosine_similarity(ref_emb, emb)
        return best_face, crop, score, ""

    f = faces[0]
    crop = frame_gray[f.y:f.y + f.h, f.x:f.x + f.w]
    if crop.size == 0:
        return None, None, 0.0, "empty_crop"
    emb = compute_embedding(crop)
    score = cosine_similarity(ref_emb, emb)
    return f, crop, score, ""


def run_face_match(
    photo_path: str,
    video_path: str,
    config: ModelConfig,
) -> tuple[FaceMatchOutput, list[FrameFaceContext]]:
    """
    Возвращает (результат сравнения, список контекстов по кадрам).
    Контексты используются в liveness и rPPG — они не детектят лицо заново.
    """
    # --- Эталонное фото ---
    ref_img = cv2.imread(photo_path)
    if ref_img is None:
        return (
            FaceMatchOutput(0.0, [], -1, config.match_threshold,
                            FaceMatchDecision.INSUFFICIENT_QUALITY.value),
            [],
        )
    ref_gray = cv2.cvtColor(ref_img, cv2.COLOR_BGR2GRAY)
    detector = FaceDetectorFactory.create(config.detector_backend)
    ref_faces = detector.detect(ref_img)
    if ref_faces:
        f = ref_faces[0]
        ref_crop = ref_gray[f.y:f.y + f.h, f.x:f.x + f.w]
    else:
        ref_crop = ref_gray
    ref_emb = compute_embedding(ref_crop)

    # --- Видео ---
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return (
            FaceMatchOutput(0.0, [], -1, config.match_threshold,
                            FaceMatchDecision.INSUFFICIENT_QUALITY.value,
                            detector_backend=config.detector_backend,
                            embedding_method=config.embedding_method),
            [],
        )

    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    sample_interval = max(1, int(fps * config.frame_sample_interval / 30))

    per_frame_scores: list[float] = []
    contexts: list[FrameFaceContext] = []
    processed = 0
    multi_face_frames = 0
    total_processed = 0
    frame_id = 0

    while frame_id < frame_count and processed < config.max_frames_to_process:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_id % sample_interval == 0:
            total_processed += 1
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = detector.detect(frame)

            raw_faces = detector.detect(frame)
            # Фильтруем некорректные боксы: ширина и высота должны быть >= 1
            faces = [f for f in faces if f.w >= 1 and f.h >= 1]
            
            #print(f"Frame {frame_id}: raw faces={len(raw_faces)}, filtered={len(faces)}")

            face_box, face_crop, score, skip_reason = _select_face(
                faces=faces,
                frame_gray=gray,
                ref_emb=ref_emb,
                strategy=config.multi_face_strategy,
                max_faces=config.max_faces_per_frame,
            )
            if len(faces) > config.max_faces_per_frame: multi_face_frames += 1

            ctx = FrameFaceContext(
                frame_index=frame_id,
                frame=frame,
                face_box=face_box,
                face_crop=face_crop,
                faces=faces,
                is_valid=(face_box is not None and face_crop is not None),
                skip_reason=skip_reason,
                match_score=score if face_box is not None else 0.0,
            )
            contexts.append(ctx)

            if ctx.is_valid:
                per_frame_scores.append(score)
                processed += 1

        frame_id += 1

    cap.release()
    print(f"Закончили обработку видое") 
    # --- Итоги ---
    detected = len(per_frame_scores)
    print(f"Итоги") 
    multi_face_ratio = multi_face_frames / max(total_processed, 1)
    print(f"multi_face_ratio=", multi_face_ratio) 
    if detected < config.min_detected_frames:
        return (
            FaceMatchOutput(
                match_score=0.0,
                per_frame_scores=per_frame_scores,
                best_frame_id=per_frame_scores.index(max(per_frame_scores)) if per_frame_scores else -1,
                threshold=config.match_threshold,
                decision=FaceMatchDecision.INSUFFICIENT_QUALITY.value,
                total_frames=frame_count,
                detected_frames=detected,
                reference_embedding_norm=float(np.linalg.norm(ref_emb)),
                detector_backend=config.detector_backend,
                embedding_method=config.embedding_method,
                skipped_multi_face_frames=multi_face_frames,
                multi_face_ratio=multi_face_ratio,
            ),
            contexts,
        )

    best_id = per_frame_scores.index(max(per_frame_scores))
    avg_score = float(np.mean(per_frame_scores))

    if avg_score >= config.match_threshold:
        decision = FaceMatchDecision.MATCH.value
    elif avg_score >= config.manual_review_threshold:
        decision = FaceMatchDecision.MANUAL_REVIEW.value
    else:
        decision = FaceMatchDecision.NO_MATCH.value
    print(f"return FaceMatchOutput") 
    return (
        FaceMatchOutput(
            match_score=avg_score,
            per_frame_scores=per_frame_scores,
            best_frame_id=best_id,
            threshold=config.match_threshold,
            decision=decision,
            total_frames=frame_count,
            detected_frames=detected,
            reference_embedding_norm=float(np.linalg.norm(ref_emb)),
            detector_backend=config.detector_backend,
            embedding_method=config.embedding_method,
            skipped_multi_face_frames=multi_face_frames,
            multi_face_ratio=multi_face_ratio,
        ),
        contexts,
    )
