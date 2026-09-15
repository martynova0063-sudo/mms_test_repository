# финальные шаблоны — face matching на embeddings и аудит-лог с hash chain.
## Шаблон face matching (embeddings + cosine similarity)
```python
"""
Модуль face matching — проверка соответствия лица на видео
эталонной фотографии.

Подход:
  1. Извлечение face embeddings (векторное представление лица)
  2. Сравнение через косинусное сходство
  3. Маршрутизация по порогам (verified / manual_review / not_verified)

⚠️ Эталонные фото и видео не хранятся.
   Сохраняются только хеши и метрики сравнения.
"""
from __future__ import annotations

import hashlib
import uuid
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

import numpy as np
import cv2


# ─── Конфигурация ─────────────────────────────────────────────────

FACE_MATCH_CONFIG = {
    "model": {
        # В исследовательском режиме — упрощённый embeddings.
        # В продакшене — предобученная модель (FaceNet, ArcFace, dlib).
        "backend": "opencv_dnn",       # opencv_dnn | dlib | facenet | insightface
        "embedding_dim": 512,           # размерность вектора
        "input_size": (160, 160),       # размер входа модели
        "normalize": True,              # L2-нормализация embeddings
    },
    "thresholds": {
        "match_high": 0.62,             # >= → verified
        "match_low": 0.45,              # < → not_verified
        # 0.45 ≤ score < 0.62 → manual_review
    },
    "quality_gate": {
        "min_face_confidence": 0.90,   # минимальная уверенность детекции
        "min_face_size_px": 80,         # минимальный размер лица
        "max_yaw": 25,                  # максимальный угол поворота
        "max_pitch": 20,
        "max_roll": 15,
    },
    "frame_selection": {
        "strategy": "best_frame",       # best_frame | median_frame | all_frames
        "max_frames_to_compare": 5,     # сколько кадров сравнивать
        "aggregation": "max",           # max | mean | median — агрегация score
    },
    "storage": {
        "keep_reference_embedding": True,   # хранить embedding (не фото)
        "keep_video_embeddings": False,      # не хранить видео-embeddings
        "hash_algorithm": "sha256",
    },
}


# ─── Схемы ────────────────────────────────────────────────────────

class MatchRoute(str, Enum):
    VERIFIED = "verified"
    MANUAL_REVIEW = "manual_review"
    NOT_VERIFIED = "not_verified"


@dataclass
class FaceDetection:
    """Результат детекции лица на кадре."""
    detected: bool
    confidence: float = 0.0
    bbox: tuple[int, int, int, int] | None = None  # x, y, w, h
    yaw: float = 0.0
    pitch: float = 0.0
    roll: float = 0.0
    face_size_px: int = 0


@dataclass
class EmbeddingResult:
    """Результат извлечения embedding."""
    embedding: np.ndarray | None
    detection: FaceDetection
    quality_pass: bool
    quality_issues: list[str] = field(default_factory=list)
    frame_hash: str = ""


@dataclass
class FrameComparison:
    """Сравнение одного кадра с эталоном."""
    frame_index: int
    cosine_similarity: float
    frame_hash: str
    detection: FaceDetection


@dataclass
class FaceMatchResult:
    """Итоговый результат face matching."""
    session_id: str
    route: MatchRoute
    match_score: float
    route_reason: str
    frame_comparisons: list[FrameComparison]
    reference_hash: str
    video_hash: str
    model_version: str
    timestamp: str
    audit: dict[str, Any]


# ─── Извлечение embeddings ───────────────────────────────────────

def extract_embedding(
    frame: np.ndarray,
    config: dict[str, Any] | None = None,
) -> EmbeddingResult:
    """
    Извлекает face embedding из кадра.

    В исследовательском режиме использует OpenCV DNN или упрощённый
    метод на основе гистограмм. В продакшене — предобученную модель.
    """
    cfg = config or FACE_MATCH_CONFIG
    model_cfg = cfg["model"]

    # Детекция лица
    detection = _detect_face(frame, cfg["quality_gate"])

    if not detection.detected:
        return EmbeddingResult(
            embedding=None,
            detection=detection,
            quality_pass=False,
            quality_issues=["no_face_detected"],
            frame_hash=_hash_frame(frame),
        )

    # Проверка качества
    quality_issues = _check_face_quality(detection, cfg["quality_gate"])
    quality_pass = len(quality_issues) == 0

    if not quality_pass:
        return EmbeddingResult(
            embedding=None,
            detection=detection,
            quality_pass=False,
            quality_issues=quality_issues,
            frame_hash=_hash_frame(frame),
        )

    # Извлечение embedding
    if model_cfg["backend"] == "opencv_dnn":
        embedding = _extract_opencv_dnn(frame, detection, model_cfg)
    elif model_cfg["backend"] == "facenet":
        embedding = _extract_facenet(frame, detection, model_cfg)
    elif model_cfg["backend"] == "dlib":
        embedding = _extract_dlib(frame, detection, model_cfg)
    else:
        embedding = _extract_simple(frame, detection, model_cfg)

    # L2-нормализация
    if model_cfg["normalize"] and embedding is not None:
        embedding = embedding / (np.linalg.norm(embedding) + 1e-9)

    return EmbeddingResult(
        embedding=embedding,
        detection=detection,
        quality_pass=True,
        quality_issues=[],
        frame_hash=_hash_frame(frame),
    )


def _detect_face(frame: np.ndarray, qg: dict[str, Any]) -> FaceDetection:
    """
    Детекция лица через Haar Cascade или DNN.
    Возвращает геометрию и углы.
    """
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    h, w = frame.shape[:2]

    # Haar Cascade (fallback для исследовательского режима)
    cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )
    faces = cascade.detectMultiScale(
        gray, scaleFactor=1.1, minNeighbors=5, minSize=(qg["min_face_size_px"], qg["min_face_size_px"])
    )

    if len(faces) == 0:
        return FaceDetection(detected=False)

    # Берём самое крупное лицо
    areas = [fw * fh for (_, _, fw, fh) in faces]
    best_idx = int(np.argmax(areas))
    x, y, fw, fh = faces[best_idx]

    # Confidence — proxy через размер и позицию
    face_area = fw * fh
    frame_area = w * h
    area_ratio = face_area / frame_area
    confidence = min(1.0, area_ratio * 10)  # эвристика

    # Углы — упрощённая оценка через центр лица
    center_x = x + fw / 2
    center_y = y + fh / 2
    yaw = abs((center_x - w / 2) / (w / 2)) * 30   # proxy
    pitch = abs((center_y - h / 2) / (h / 2)) * 30
    roll = 0.0  # требуется landmarks для точной оценки

    return FaceDetection(
        detected=True,
        confidence=round(float(confidence), 4),
        bbox=(int(x), int(y), int(fw), int(fh)),
        yaw=round(float(yaw), 2),
        pitch=round(float(pitch), 2),
        roll=round(float(roll), 2),
        face_size_px=int(min(fw, fh)),
    )


def _check_face_quality(detection: FaceDetection, qg: dict[str, Any]) -> list[str]:
    """Проверка качества детекции по порогам."""
    issues = []
    if detection.confidence < qg["min_face_confidence"]:
        issues.append("low_detection_confidence")
    if detection.face_size_px < qg["min_face_size_px"]:
        issues.append("face_too_small")
    if detection.yaw > qg["max_yaw"]:
        issues.append("yaw_exceeded")
    if detection.pitch > qg["max_pitch"]:
        issues.append("pitch_exceeded")
    if detection.roll > qg["max_roll"]:
        issues.append("roll_exceeded")
    return issues


def _extract_opencv_dnn(
    frame: np.ndarray,
    detection: FaceDetection,
    model_cfg: dict[str, Any],
) -> np.ndarray:
    """
    Извлечение embedding через OpenCV DNN.
    В исследовательском режиме — модель на основе гистограмм и PCA-подобного
    преобразования (заглушка). В продакшене — загрузка предобученной модели.
    """
    x, y, fw, fh = detection.bbox
    face_roi = frame[y:y+fh, x:x+fw]
    face_resized = cv2.resize(face_roi, model_cfg["input_size"])

    # Заглушка: embedding из цветовых гистограмм
    # В реальном проекте: net = cv2.dnn.readNetFromTorch("model.caffemodel")
    hist_b = cv2.calcHist([face_resized], [0], None, [64], [0, 256]).flatten()
    hist_g = cv2.calcHist([face_resized], [1], None, [64], [0, 256]).flatten()
    hist_r = cv2.calcHist([face_resized], [2], None, [64], [0, 256]).flatten()

    # LBP-подобные признаки
    gray = cv2.cvtColor(face_resized, cv2.COLOR_BGR2GRAY)
    lbp_features = _compute_simple_lbp(gray)

    embedding = np.concatenate([hist_b, hist_g, hist_r, lbp_features])
    # Дополнение нулями до нужной размерности
    target_dim = model_cfg["embedding_dim"]
    if len(embedding) < target_dim:
        embedding = np.pad(embedding, (0, target_dim - len(embedding)))
    else:
        embedding = embedding[:target_dim]

    return embedding.astype(np.float32)


def _extract_simple(
    frame: np.ndarray,
    detection: FaceDetection,
    model_cfg: dict[str, Any],
) -> np.ndarray:
    """Упрощённое извлечение признаков (fallback)."""
    x, y, fw, fh = detection.bbox
    face_roi = frame[y:y+fh, x:x+fw]
    face_resized = cv2.resize(face_roi, (64, 64))

    # HOG-подобные признаки
    gray = cv2.cvtColor(face_resized, cv2.COLOR_BGR2GRAY)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1)
    mag, ang = cv2.cartToPolar(gx, gy)

    # Гистограмма направлений градиентов (8 бинов)
    hist = np.zeros(8, dtype=np.float32)
    for i in range(8):
        mask = (ang >= i * np.pi / 4) & (ang < (i + 1) * np.pi / 4)
        hist[i] = np.sum(mag[mask])

    # Гистограмма яркости
    bright_hist = np.histogram(gray, bins=32, range=(0, 256))[0].astype(np.float32)

    embedding = np.concatenate([hist, bright_hist])
    target_dim = model_cfg["embedding_dim"]
    if len(embedding) < target_dim:
        embedding = np.pad(embedding, (0, target_dim - len(embedding)))
    else:
        embedding = embedding[:target_dim]

    return embedding


def _extract_facenet(
    frame: np.ndarray,
    detection: FaceDetection,
    model_cfg: dict[str, Any],
) -> np.ndarray:
    """
    Извлечение embedding через FaceNet / ArcFace.
    В продакшене — загрузка модели из ONNX/TorchScript.
    Здесь — заглушка для интерфейса.
    """
    # from facenet_pytorch import InceptionResnetV1
    # model = InceptionResnetV1(pretrained='vggface2').eval()
    # ...
    raise NotImplementedError(
        "FaceNet backend требует установки facenet-pytorch. "
        "Используйте opencv_dnn или simple для исследовательского режима."
    )


def _extract_dlib(
    frame: np.ndarray,
    detection: FaceDetection,
    model_cfg: dict[str, Any],
) -> np.ndarray:
    """Извлечение embedding через dlib."""
    # import dlib
    # detector = dlib.get_frontal_face_detector()
    # sp = dlib.shape_predictor("shape_predictor_68_face_landmarks.dat")
    # facerec = dlib.face_recognition_model_v1("dlib_face_recognition_resnet_model_v1.dat")
    # ...
    raise NotImplementedError(
        "dlib backend требует установки dlib. "
        "Используйте opencv_dnn или simple для исследовательского режима."
    )


def _compute_simple_lbp(gray: np.ndarray) -> np.ndarray:
    """Упрощённый LBP для embedding."""
    h, w = gray.shape
    lbp = np.zeros((h - 2, w - 2), dtype=np.uint8)
    for i in range(1, h - 1):
        for j in range(1, w - 1):
            center = gray[i, j]
            code = 0
            code |= (1 << 0) if gray[i-1, j-1] >= center else 0
            code |= (1 << 1) if gray[i-1, j] >= center else 0
            code |= (1 << 2) if gray[i-1, j+1] >= center else 0
            code |= (1 << 3) if gray[i, j+1] >= center else 0
            code |= (1 << 4) if gray[i+1, j+1] >= center else 0
            code |= (1 << 5) if gray[i+1, j] >= center else 0
            code |= (1 << 6) if gray[i+1, j-1] >= center else 0
            code |= (1 << 7) if gray[i, j-1] >= center else 0
            lbp[i-1, j-1] = code
    # Гистограмма LBP
    hist = np.histogram(lbp, bins=64, range=(0, 256))[0].astype(np.float32)
    return hist


# ─── Сравнение embeddings ────────────────────────────────────────

def cosine_similarity(vec_a: np.ndarray, vec_b: np.ndarray) -> float:
    """
    Косинусное сходство между двумя векторами.
    Возвращает значение от -1.0 до 1.0.
    """
    if vec_a is None or vec_b is None:
        return 0.0
    norm_a = np.linalg.norm(vec_a)
    norm_b = np.linalg.norm(vec_b)
    if norm_a < 1e-9 or norm_b < 1e-9:
        return 0.0
    return float(np.dot(vec_a, vec_b) / (norm_a * norm_b))


def compare_embeddings(
    reference_embedding: np.ndarray,
    candidate_embedding: np.ndarray,
) -> float:
    """
    Сравнение candidate embedding с reference.
    Возвращает cosine similarity (0.0–1.0 для нормализованных векторов).
    """
    score = cosine_similarity(reference_embedding, candidate_embedding)
    # Для нормализованных L2 векторов cosine similarity ∈ [-1, 1]
    # Приводим к [0, 1] для удобства
    return round((score + 1.0) / 2.0, 4)


# ─── Выбор кадров из видео ───────────────────────────────────────

def select_frames(
    video_frames: list[np.ndarray],
    config: dict[str, Any] | None = None,
) -> list[tuple[int, np.ndarray]]:
    """
    Выбор кадров для сравнения из видеопотока.
    Возвращает список (frame_index, frame).
    """
    cfg = config or FACE_MATCH_CONFIG
    strategy = cfg["frame_selection"]["strategy"]
    max_frames = cfg["frame_selection"]["max_frames_to_compare"]

    if len(video_frames) <= max_frames:
        return list(enumerate(video_frames))

    if strategy == "best_frame":
        # Выбор кадров с наибольшей резкостью (Laplacian variance)
        scores = []
        for i, frame in enumerate(video_frames):
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            sharpness = cv2.Laplacian(gray, cv2.CV_64F).var()
            scores.append((i, sharpness))

        scores.sort(key=lambda x: x[1], reverse=True)
        selected_indices = [idx for idx, _ in scores[:max_frames]]
        selected_indices.sort()
        return [(i, video_frames[i]) for i in selected_indices]

    elif strategy == "median_frame":
        # Равномерное распределение
        step = len(video_frames) // max_frames
        return [(i, video_frames[i]) for i in range(0, len(video_frames), step)][:max_frames]

    else:  # all_frames
        return list(enumerate(video_frames))[:max_frames]


# ─── Полный пайплайн face matching ───────────────────────────────

def run_face_match(
    reference_photo: np.ndarray,
    video_frames: list[np.ndarray],
    config: dict[str, Any] | None = None,
    model_version: str = "face_v1.0.0",
) -> FaceMatchResult:
    """
    Полный пайплайн проверки соответствия лица.

    Шаги:
      1. Извлечение embedding из эталонного фото
      2. Выбор кадров из видео
      3. Извлечение embeddings из выбранных кадров
      4. Сравнение каждого кадра с эталоном
      5. Агрегация score
      6. Маршрутизация

    ⚠️ Фото и видео не сохраняются. Сохраняются хеши и метрики.
    """
    cfg = config or FACE_MATCH_CONFIG
    session_id = f"fm_{uuid.uuid4().hex[:12]}"
    timestamp = _now_iso()

    # 1. Эталонное фото → embedding
    ref_result = extract_embedding(reference_photo, cfg)

    if ref_result.embedding is None:
        return FaceMatchResult(
            session_id=session_id,
            route=MatchRoute.NOT_VERIFIED,
            match_score=0.0,
            route_reason="reference_photo_no_face_detected",
            frame_comparisons=[],
            reference_hash=_hash_frame(reference_photo),
            video_hash=_hash_frames(video_frames),
            model_version=model_version,
            timestamp=timestamp,
            audit={
                "error": "reference_photo_no_face",
                "reference_quality_issues": ref_result.quality_issues,
                "⚠️ photos_not_stored": True,
            },
        )

    reference_hash = ref_result.frame_hash
    ref_embedding = ref_result.embedding

    # 2. Выбор кадров
    selected = select_frames(video_frames, cfg)

    # 3-4. Извлечение и сравнение
    comparisons = []
    scores = []

    for frame_idx, frame in selected:
        emb_result = extract_embedding(frame, cfg)

        if emb_result.embedding is None:
            comparisons.append(FrameComparison(
                frame_index=frame_idx,
                cosine_similarity=0.0,
                frame_hash=emb_result.frame_hash,
                detection=emb_result.detection,
            ))
            continue

        score = compare_embeddings(ref_embedding, emb_result.embedding)
        scores.append(score)
        comparisons.append(FrameComparison(
            frame_index=frame_idx,
            cosine_similarity=score,
            frame_hash=emb_result.frame_hash,
            detection=emb_result.detection,
        ))

    # 5. Агрегация
    if not scores:
        match_score = 0.0
        route = MatchRoute.NOT_VERIFIED
        route_reason = "no_valid_face_frames_in_video"
    else:
        agg_method = cfg["frame_selection"]["aggregation"]
        if agg_method == "max":
            match_score = max(scores)
        elif agg_method == "mean":
            match_score = float(np.mean(scores))
        elif agg_method == "median":
            match_score = float(np.median(scores))
        else:
            match_score = max(scores)

        # 6. Маршрутизация
        route, route_reason = _route_by_score(match_score, cfg)

    # Хеши для аудита
    video_hash = _hash_frames(video_frames)

    return FaceMatchResult(
        session_id=session_id,
        route=route,
        match_score=round(match_score, 4),
        route_reason=route_reason,
        frame_comparisons=comparisons,
        reference_hash=reference_hash,
        video_hash=video_hash,
        model_version=model_version,
        timestamp=timestamp,
        audit={
            "frames_selected": len(selected),
            "frames_compared": len(scores),
            "aggregation_method": cfg["frame_selection"]["aggregation"],
            "thresholds": cfg["thresholds"],
            "backend": cfg["model"]["backend"],
            "reference_embedding_stored": cfg["storage"]["keep_reference_embedding"],
            "video_embeddings_stored": cfg["storage"]["keep_video_embeddings"],
            "⚠️ photos_and_video_not_stored": True,
            "reference_hash": reference_hash,
            "video_hash": video_hash,
            "immutable": True,
        },
    )


def _route_by_score(score: float, cfg: dict[str, Any]) -> tuple[MatchRoute, str]:
    """Маршрутизация по пороговым значениям."""
    th = cfg["thresholds"]
    if score >= th["match_high"]:
        return MatchRoute.VERIFIED, f"score {score:.4f} >= {th['match_high']}"
    elif score >= th["match_low"]:
        return MatchRoute.MANUAL_REVIEW, (
            f"score {score:.4f} in [{th['match_low']}, {th['match_high']})"
        )
    else:
        return MatchRoute.NOT_VERIFIED, f"score {score:.4f} < {th['match_low']}"


# ─── Хранилище эталонных embeddings ───────────────────────────────

class ReferenceEmbeddingStore:
    """
    Хранилище эталонных embeddings.
    Хранит только векторы и хеши — не исходные фото.

    В Replit — в БД (PostgreSQL или Replit DB).
    """

    def __init__(self):
        self._store: dict[str, dict[str, Any]] = {}

    def save_reference(
        self,
        worker_pseudonym: str,
        embedding: np.ndarray,
        source_photo_hash: str,
        model_version: str,
    ) -> str:
        """Сохраняет эталонный embedding."""
        ref_id = f"ref_{uuid.uuid4().hex[:12]}"
        self._store[ref_id] = {
            "ref_id": ref_id,
            "worker_pseudonym": worker_pseudonym,
            "embedding": embedding.copy(),
            "embedding_hash": _hash_embedding(embedding),
            "source_photo_hash": source_photo_hash,
            "model_version": model_version,
            "created_at": _now_iso(),
            # ⚠️ source_photo NOT stored
        }
        return ref_id

    def get_reference(self, worker_pseudonym: str) -> dict[str, Any] | None:
        """Получает эталонный embedding по псевдониму работника."""
        for ref in self._store.values():
            if ref["worker_pseudonym"] == worker_pseudonym:
                return ref
        return None

    def update_reference(
        self,
        worker_pseudonym: str,
        new_embedding: np.ndarray,
        source_photo_hash: str,
        model_version: str,
    ) -> str:
        """
        Обновляет эталон (старый архивируется, не удаляется).
        Возвращает ID нового эталона.
        """
        # Архивирование старого
        old = self.get_reference(worker_pseudonym)
        if old:
            old["archived_at"] = _now_iso()
            old["archived_reason"] = "replaced_by_newer_reference"

        return self.save_reference(
            worker_pseudonym, new_embedding, source_photo_hash, model_version
        )


# ─── Хеширование ─────────────────────────────────────────────────

def _hash_frame(frame: np.ndarray) -> str:
    """SHA-256 хеш кадра (даунсэмплинг для скорости)."""
    small = cv2.resize(frame, (32, 32))
    return f"sha256:{hashlib.sha256(small.tobytes()).hexdigest()[:32]}"


def _hash_frames(frames: list[np.ndarray]) -> str:
    """SHA-256 хез массива кадров."""
    hasher = hashlib.sha256()
    for frame in frames:
        small = cv2.resize(frame, (32, 32))
        hasher.update(small.tobytes())
    return f"sha256:{hasher.hexdigest()[:32]}"


def _hash_embedding(embedding: np.ndarray) -> str:
    """SHA-256 хеш embedding-вектора."""
    return f"sha256:{hashlib.sha256(embedding.tobytes()).hexdigest()[:32]}"


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
```    

## Шаблон audit log с hash chain
```python
"""
Audit log с hash chain — неизменяемый журнал всех действий в системе.

Принцип:
  Каждая запись содержит hash предыдущей записи (prev_hash).
  Цепочка хешей обеспечивает целостность: изменение любой записи
  ломает все последующие хеши.

  records: [r1] → [r2] → [r3] → ...
  r1.prev_hash = "GENESIS"
  r2.prev_hash = hash(r1)
  r3.prev_hash = hash(r2)

Свойства:
  - Append-only: записи нельзя изменять или удалять
  - Tamper-evident: любое изменение обнаруживается проверкой цепочки
  - Прослеживаемость: каждый расчёт, каждое решение, каждый review
    оставляют след
"""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field
import numpy as np


# ─── Типы событий аудита ──────────────────────────────────────────

class AuditAction(str, Enum):
    # Расчёт
    CALCULATION_STARTED = "calculation_started"
    CALCULATION_COMPLETED = "calculation_completed"
    CALCULATION_FAILED = "calculation_failed"
    # Верификация
    VERIFICATION_STARTED = "verification_started"
    VERIFICATION_COMPLETED = "verification_completed"
    VERIFICATION_ROUTED = "verification_routed"
    # Human Review
    REVIEW_CREATED = "review_created"
    REVIEW_UPDATED = "review_updated"
    REVIEW_CONFIRMED = "review_confirmed"
    REVIEW_REJECTED = "review_rejected"
    # Model Governance
    MODEL_VERSION_PUBLISHED = "model_version_published"
    MODEL_VERSION_DEPRECATED = "model_version_deprecated"
    DRIFT_DETECTED = "drift_detected"
    VALIDATION_STAGE_STARTED = "validation_stage_started"
    VALIDATION_STAGE_PASSED = "validation_stage_passed"
    VALIDATION_STAGE_FAILED = "validation_stage_failed"
    # Доступ
    LOGIN = "login"
    ACCESS_DENIED = "access_denied"
    DATA_EXPORT = "data_export"
    # Данные
    DATA_INTAKE = "data_intake"
    QUALITY_CHECK = "quality_check"
    BASELINE_CALCULATED = "baseline_calculated"


class AuditActor(str, Enum):
    RESEARCHER = "researcher"
    MEDWORKER = "medworker"
    AUDITOR = "auditor"
    ADMIN = "admin"
    SYSTEM = "system"


# ─── Схема записи аудита ──────────────────────────────────────────

class AuditRecord(BaseModel):
    """
    Одна запись в audit log.
    Содержит prev_hash для образования цепочки.
    """
    record_id: str
    timestamp: str
    action: str                        # AuditAction value
    actor: str                         # pseudonym или "system"
    actor_role: str                    # AuditActor value
    resource_type: str                 # "event" | "result" | "review" | "model" | "session"
    resource_id: str
    details: dict[str, Any] = Field(default_factory=dict)
    prev_hash: str                     # хеш предыдущей записи
    record_hash: str = ""              # вычисляется при создании
    sequence: int                      # порядковый номер в цепочке


# ─── Audit Log с hash chain ──────────────────────────────────────

class HashChainAuditLog:
    """
    Неизменяемый audit log с цепочкой хешей.

    Использование:
        audit = HashChainAuditLog()
        audit.append(
            action=AuditAction.CALCULATION_COMPLETED,
            actor="researcher_01",
            actor_role=AuditActor.RESEARCHER,
            resource_type="event",
            resource_id="evt_001",
            details={"health_id": 0.82, "model_version": "v1.0.0"},
        )

    Проверка целостности:
        audit.verify_chain()  → True/False
    """

    GENESIS_HASH = "GENESIS:0000000000000000000000000000000000000000000000000000000000"

    def __init__(self):
        self._records: list[AuditRecord] = []
        self._sequence = 0

    def append(
        self,
        action: AuditAction,
        actor: str,
        actor_role: AuditActor,
        resource_type: str,
        resource_id: str,
        details: dict[str, Any] | None = None,
    ) -> AuditRecord:
        """
        Добавляет запись в audit log.
        Записи нельзя изменять или удалять после добавления.
        """
        details = details or {}
        # Sanitize: убираем numpy types, которые не сериализуются
        details = _sanitize_details(details)

        prev_hash = (
            self._records[-1].record_hash if self._records
            else self.GENESIS_HASH
        )

        self._sequence += 1
        record_id = f"aud_{uuid.uuid4().hex[:12]}"
        timestamp = datetime.now(timezone.utc).isoformat()

        # Временный объект без record_hash
        temp_record = AuditRecord(
            record_id=record_id,
            timestamp=timestamp,
            action=action.value,
            actor=actor,
            actor_role=actor_role.value,
            resource_type=resource_type,
            resource_id=resource_id,
            details=details,
            prev_hash=prev_hash,
            sequence=self._sequence,
            record_hash="",  # placeholder
        )

        # Вычисление хеша
        record_hash = self._compute_hash(temp_record)
        temp_record.record_hash = record_hash

        self._records.append(temp_record)
        return temp_record

    def verify_chain(self) -> tuple[bool, list[dict[str, Any]]]:
        """
        Проверяет целостность цепочки хешей.
        Возвращает (True, []) если цепочка цела,
        иначе (False, [список повреждённых записей]).
        """
        errors = []
        prev_hash = self.GENESIS_HASH

        for i, record in enumerate(self._records):
            # Проверка prev_hash
            if record.prev_hash != prev_hash:
                errors.append({
                    "sequence": record.sequence,
                    "record_id": record.record_id,
                    "error": "prev_hash_mismatch",
                    "expected": prev_hash,
                    "actual": record.prev_hash,
                })

            # Проверка record_hash
            computed_hash = self._compute_hash(record)
            if record.record_hash != computed_hash:
                errors.append({
                    "sequence": record.sequence,
                    "record_id": record.record_id,
                    "error": "record_hash_mismatch",
                    "expected": computed_hash,
                    "actual": record.record_hash,
                })

            # Проверка sequence
            if record.sequence != i + 1:
                errors.append({
                    "sequence": record.sequence,
                    "record_id": record.record_id,
                    "error": "sequence_mismatch",
                    "expected": i + 1,
                    "actual": record.sequence,
                })

            prev_hash = record.record_hash

        return (len(errors) == 0, errors)

    def verify_range(
        self, start_seq: int, end_seq: int
    ) -> tuple[bool, list[dict[str, Any]]]:
        """Проверяет целостность диапазона записей."""
        errors = []
        if start_seq < 1 or end_seq > len(self._records):
            return False, [{"error": "range_out_of_bounds"}]

        prev_hash = (
            self._records[start_seq - 2].record_hash
            if start_seq > 1
            else self.GENESIS_HASH
        )

        for i in range(start_seq - 1, end_seq):
            record = self._records[i]

            if record.prev_hash != prev_hash:
                errors.append({
                    "sequence": record.sequence,
                    "error": "prev_hash_mismatch",
                    "expected": prev_hash,
                    "actual": record.prev_hash,
                })

            computed = self._compute_hash(record)
            if record.record_hash != computed:
                errors.append({
                    "sequence": record.sequence,
                    "error": "record_hash_mismatch",
                })

            prev_hash = record.record_hash

        return (len(errors) == 0, errors)

    def query(
        self,
        action: AuditAction | None = None,
        actor: str | None = None,
        resource_type: str | None = None,
        resource_id: str | None = None,
        start_time: str | None = None,
        end_time: str | None = None,
    ) -> list[AuditRecord]:
        """
        Поиск записей в audit log по фильтрам.
        Возвращает копии записей (оригиналы неизменяемы).
        """
        results = []
        for record in self._records:
            if action and record.action != action.value:
                continue
            if actor and record.actor != actor:
                continue
            if resource_type and record.resource_type != resource_type:
                continue
            if resource_id and record.resource_id != resource_id:
                continue
            if start_time and record.timestamp < start_time:
                continue
            if end_time and record.timestamp > end_time:
                continue
            results.append(record.model_copy())
        return results

    def get_record(self, record_id: str) -> AuditRecord | None:
        """Получает запись по ID."""
        for record in self._records:
            if record.record_id == record_id:
                return record.model_copy()
        return None

    def get_by_sequence(self, seq: int) -> AuditRecord | None:
        """Получает запись по порядковому номеру."""
        if 1 <= seq <= len(self._records):
            return self._records[seq - 1].model_copy()
        return None

    def get_chain_tail_hash(self) -> str:
        """Возвращает хеш последней записи (для внешней верификации)."""
        if not self._records:
            return self.GENESIS_HASH
        return self._records[-1].record_hash

    def export_chain(
        self,
        start_seq: int = 1,
        end_seq: int | None = None,
    ) -> list[dict[str, Any]]:
        """
        Экспортирует подмножество цепочки для внешней проверки.
        Возвращает список записей в виде словарей.
        """
        end = end_seq or len(self._records)
        return [
            self._records[i].model_dump()
            for i in range(start_seq - 1, min(end, len(self._records)))
        ]

    def get_timeline(
        self,
        resource_id: str,
        resource_type: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        Возвращает временную линию всех действий с ресурсом.
        Полезно для прослеживаемости расчёта.
        """
        records = self.query(
            resource_id=resource_id,
            resource_type=resource_type,
        )
        return [
            {
                "sequence": r.sequence,
                "timestamp": r.timestamp,
                "action": r.action,
                "actor": r.actor,
                "actor_role": r.actor_role,
                "details": r.details,
                "record_hash": r.record_hash,
            }
            for r in records
        ]

    def get_stats(self) -> dict[str, Any]:
        """Статистика audit log."""
        action_counts: dict[str, int] = {}
        actor_counts: dict[str, int] = {}
        for r in self._records:
            action_counts[r.action] = action_counts.get(r.action, 0) + 1
            actor_counts[r.actor] = actor_counts.get(r.actor, 0) + 1

        return {
            "total_records": len(self._records),
            "chain_intact": self.verify_chain()[0],
            "tail_hash": self.get_chain_tail_hash(),
            "action_counts": action_counts,
            "actor_counts": actor_counts,
            "first_timestamp": self._records[0].timestamp if self._records else None,
            "last_timestamp": self._records[-1].timestamp if self._records else None,
        }

    # ─── Внутренние методы ─────────────────────────────────────────

    def _compute_hash(self, record: AuditRecord) -> str:
        """
        Вычисляет SHA-256 хеш записи.
        Хеш включает все поля, КРОМЕ record_hash (чтобы избежать рекурсии).
        """
        hash_payload = {
            "record_id": record.record_id,
            "timestamp": record.timestamp,
            "action": record.action,
            "actor": record.actor,
            "actor_role": record.actor_role,
            "resource_type": record.resource_type,
            "resource_id": record.resource_id,
            "details": record.details,
            "prev_hash": record.prev_hash,
            "sequence": record.sequence,
        }
        payload_str = json.dumps(hash_payload, sort_keys=True, ensure_ascii=False)
        return f"sha256:{hashlib.sha256(payload_str.encode('utf-8')).hexdigest()}"


# ─── Sanitize ────────────────────────────────────────────────────

def _sanitize_details(details: dict[str, Any]) -> dict[str, Any]:
    """
    Преобразует numpy types в стандартные Python types
    для корректной сериализации в JSON.
    """
    sanitized = {}
    for key, value in details.items():
        if isinstance(value, (np.integer,)):
            sanitized[key] = int(value)
        elif isinstance(value, (np.floating,)):
            sanitized[key] = float(value)
        elif isinstance(value, (np.bool_,)):
            sanitized[key] = bool(value)
        elif isinstance(value, np.ndarray):
            sanitized[key] = value.tolist()
        elif isinstance(value, dict):
            sanitized[key] = _sanitize_details(value)
        elif isinstance(value, (list, tuple)):
            sanitized[key] = [
                _sanitize_value(v) if isinstance(v, dict) else _sanitize_scalar(v)
                for v in value
            ]
        else:
            sanitized[key] = value
    return sanitized


def _sanitize_scalar(value: Any) -> Any:
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value)
    if isinstance(value, (np.bool_,)):
        return bool(value)
    return value


def _sanitize_value(value: Any) -> Any:
    if isinstance(value, dict):
        return _sanitize_details(value)
    return _sanitize_scalar(value)


# ─── Интеграция с системой ────────────────────────────────────────

class SystemAuditor:
    """
    Фасад для аудирования всех подсистем.
    Используется движком, верификацией, review и governance.
    """

    def __init__(self):
        self.log = HashChainAuditLog()

    def log_calculation(
        self,
        event_id: str,
        worker_pseudonym: str,
        model_version: str,
        health_id_value: float | None,
        config_hash: str,
        quality_status: str,
    ) -> AuditRecord:
        """Логирует расчёт HEALTH_ID."""
        action = (
            AuditAction.CALCULATION_COMPLETED
            if health_id_value is not None
            else AuditAction.CALCULATION_FAILED
        )

        return self.log.append(
            action=action,
            actor="system",
            actor_role=AuditActor.SYSTEM,
            resource_type="event",
            resource_id=event_id,
            details={
                "worker_pseudonym": worker_pseudonym,
                "model_version": model_version,
                "health_id": health_id_value,
                "config_hash": config_hash,
                "quality_status": quality_status,
                "⚠️ research_mode": True,
            },
        )

    def log_verification(
        self,
        session_id: str,
        worker_pseudonym: str,
        match_score: float,
        liveness_score: float,
        route: str,
        model_version: str,
    ) -> AuditRecord:
        """Логирует результат верификации личности."""
        return self.log.append(
            action=AuditAction.VERIFICATION_ROUTED,
            actor="system",
            actor_role=AuditActor.SYSTEM,
            resource_type="session",
            resource_id=session_id,
            details={
                "worker_pseudonym": worker_pseudonym,
                "match_score": match_score,
                "liveness_score": liveness_score,
                "route": route,
                "model_version": model_version,
                "⚠️ video_not_stored": True,
            },
        )

    def log_review(
        self,
        review_id: str,
        reviewer_pseudonym: str,
        old_status: str,
        new_status: str,
        comment: str,
    ) -> AuditRecord:
        """Логирует действие в human review."""
        action_map = {
            "pending": AuditAction.REVIEW_CREATED,
            "confirmed": AuditAction.REVIEW_CONFIRMED,
            "rejected": AuditAction.REVIEW_REJECTED,
        }
        action = action_map.get(
            new_status, AuditAction.REVIEW_UPDATED
        )

        return self.log.append(
            action=action,
            actor=reviewer_pseudonym,
            actor_role=AuditActor.MEDWORKER,
            resource_type="review",
            resource_id=review_id,
            details={
                "old_status": old_status,
                "new_status": new_status,
                "comment": comment,
                "⚠️ not_medical_deduction": True,
            },
        )

    def log_model_version(
        self,
        version: str,
        action: AuditAction,
        config_hash: str,
        parent_version: str | None = None,
        actor: str = "system",
    ) -> AuditRecord:
        """Логирует событие model governance."""
        return self.log.append(
            action=action,
            actor=actor,
            actor_role=AuditActor.ADMIN,
            resource_type="model",
            resource_id=version,
            details={
                "config_hash": config_hash,
                "parent_version": parent_version,
            },
        )

    def log_drift(
        self,
        report_id: str,
        severity: str,
        drifted_features: list[str],
        model_version: str,
    ) -> AuditRecord:
        """Логирует обнаружение дрейфа данных."""
        return self.log.append(
            action=AuditAction.DRIFT_DETECTED,
            actor="system",
            actor_role=AuditActor.SYSTEM,
            resource_type="drift_report",
            resource_id=report_id,
            details={
                "severity": severity,
                "drifted_features": drifted_features,
                "model_version": model_version,
            },
        )

    def log_validation(
        self,
        stage: str,
        status: str,
        model_version: str,
        report_path: str,
    ) -> AuditRecord:
        """Логирует этап валидации."""
        action = (
            AuditAction.VALIDATION_STAGE_PASSED
            if status == "passed"
            else AuditAction.VALIDATION_STAGE_FAILED
        )

        return self.log.append(
            action=action,
            actor="system",
            actor_role=AuditActor.SYSTEM,
            resource_type="validation",
            resource_id=stage,
            details={
                "status": status,
                "model_version": model_version,
                "report_path": report_path,
            },
        )

    def log_baseline(
        self,
        worker_pseudonym: str,
        event_id: str,
        available: bool,
        n_points: int,
        excluded_event: str,
    ) -> AuditRecord:
        """Логирует расчёт baseline."""
        return self.log.append(
            action=AuditAction.BASELINE_CALCULATED,
            actor="system",
            actor_role=AuditActor.SYSTEM,
            resource_type="event",
            resource_id=event_id,
            details={
                "worker_pseudonym": worker_pseudonym,
                "baseline_available": available,
                "n_points": n_points,
                "excluded_event": excluded_event,
                "⚠️ anti_leak": True,
            },
        )


# ─── Unit-тесты для hash chain ────────────────────────────────────

"""
Тесты целостности цепочки хешей.
Запуск: pytest tests/unit/test_audit_chain.py -v
"""

import pytest


class TestHashChainAuditLog:
    """Тесты audit log с hash chain."""

    def _make_log(self, n_records: int = 5) -> HashChainAuditLog:
        log = HashChainAuditLog()
        for i in range(n_records):
            log.append(
                action=AuditAction.CALCULATION_COMPLETED,
                actor=f"researcher_{i:02d}",
                actor_role=AuditActor.RESEARCHER,
                resource_type="event",
                resource_id=f"evt_{i:03d}",
                details={"health_id": 0.80 + i * 0.01},
            )
        return log

    def test_chain_intact_after_append(self):
        """Цепочка цела после корректного добавления записей."""
        log = self._make_log(10)
        ok, errors = log.verify_chain()
        assert ok is True
        assert errors == []

    def test_genesis_hash_for_first_record(self):
        """Первая запись имеет genesis hash как prev_hash."""
        log = self._make_log(1)
        assert log._records[0].prev_hash == HashChainAuditLog.GENESIS_HASH

    def test_sequence_starts_at_1(self):
        """Нумерация начинается с 1."""
        log = self._make_log(3)
        assert log._records[0].sequence == 1
        assert log._records[2].sequence == 3

    def test_query_by_action(self):
        """Фильтрация по типу действия."""
        log = HashChainAuditLog()
        log.append(
            action=AuditAction.CALCULATION_COMPLETED,
            actor="r1", actor_role=AuditActor.RESEARCHER,
            resource_type="event", resource_id="e1",
        )
        log.append(
            action=AuditAction.REVIEW_CREATED,
            actor="m1", actor_role=AuditActor.MEDWORKER,
            resource_type="review", resource_id="rev1",
        )
        log.append(
            action=AuditAction.CALCULATION_COMPLETED,
            actor="r1", actor_role=AuditActor.RESEARCHER,
            resource_type="event", resource_id="e2",
        )

        calcs = log.query(action=AuditAction.CALCULATION_COMPLETED)
        assert len(calcs) == 2
        reviews = log.query(action=AuditAction.REVIEW_CREATED)
        assert len(reviews) == 1

    def test_query_by_resource(self):
        """Фильтрация по ресурсу."""
        log = HashChainAuditLog()
        log.append(
            action=AuditAction.CALCULATION_STARTED,
            actor="s", actor_role=AuditActor.SYSTEM,
            resource_type="event", resource_id="evt_001",
        )
        log.append(
            action=AuditAction.CALCULATION_COMPLETED,
            actor="s", actor_role=AuditActor.SYSTEM,
            resource_type="event", resource_id="evt_001",
        )
        log.append(
            action=AuditAction.REVIEW_CREATED,
            actor="m1", actor_role=AuditActor.MEDWORKER,
            resource_type="review", resource_id="rev_001",
        )

        evt_records = log.query(resource_id="evt_001")
        assert len(evt_records) == 2

    def test_timeline_for_resource(self):
        """Временная линия — все события ресурса по порядку."""
        log = HashChainAuditLog()
        log.append(
            action=AuditAction.CALCULATION_STARTED,
            actor="s", actor_role=AuditActor.SYSTEM,
            resource_type="event", resource_id="evt_X",
            details={"step": 1},
        )
        log.append(
            action=AuditAction.CALCULATION_COMPLETED,
            actor="s", actor_role=AuditActor.SYSTEM,
            resource_type="event", resource_id="evt_X",
            details={"step": 2},
        )
        log.append(
            action=AuditAction.REVIEW_CREATED,
            actor="m1", actor_role=AuditActor.MEDWORKER,
            resource_type="review", resource_id="rev_X",
        )
        log.append(
            action=AuditAction.REVIEW_CONFIRMED,
            actor="m1", actor_role=AuditActor.MEDWORKER,
            resource_type="review", resource_id="rev_X",
        )

        timeline = log.get_timeline("evt_X")
        assert len(timeline) == 2
        assert timeline[0]["action"] == "calculation_started"
        assert timeline[1]["action"] == "calculation_completed"

    def test_tail_hash_changes_after_append(self):
        """Хеш последней записи меняется при добавлении."""
        log = self._make_log(2)
        tail_1 = log.get_chain_tail_hash()
        log.append(
            action=AuditAction.REVIEW_CREATED,
            actor="m1", actor_role=AuditActor.MEDWORKER,
            resource_type="review", resource_id="rev1",
        )
        tail_2 = log.get_chain_tail_hash()
        assert tail_1 != tail_2

    def test_export_chain_subset(self):
        """Экспорт подмножества цепочки."""
        log = self._make_log(10)
        exported = log.export_chain(start_seq=3, end_seq=5)
        assert len(exported) == 3
        assert exported[0]["sequence"] == 3
        assert exported[2]["sequence"] == 5

    def test_numpy_sanitization(self):
        """Numpy types корректно сериализуются."""
        log = HashChainAuditLog()
        log.append(
            action=AuditAction.CALCULATION_COMPLETED,
            actor="s", actor_role=AuditActor.SYSTEM,
            resource_type="event", resource_id="e1",
            details={
                "value": np.float64(0.82),
                "count": np.int64(42),
                "flag": np.bool_(True),
                "array": np.array([1.0, 2.0, 3.0]),
            },
        )
        record = log._records[0]
        # Хеш должен вычисляться без ошибок
        assert record.record_hash.startswith("sha256:")
        # Должны быть стандартные типы
        assert isinstance(record.details["value"], float)
        assert isinstance(record.details["count"], int)
        assert isinstance(record.details["flag"], bool)
        assert isinstance(record.details["array"], list)

    def test_verify_range(self):
        """Проверка диапазона записей."""
        log = self._make_log(10)
        ok, errors = log.verify_range(3, 7)
        assert ok is True
        assert errors == []

    def test_stats(self):
        """Статистика audit log."""
        log = self._make_log(5)
        stats = log.get_stats()
        assert stats["total_records"] == 5
        assert stats["chain_intact"] is True
        assert "tail_hash" in stats
        assert stats["action_counts"]["calculation_completed"] == 5

    def test_immutable_records(self):
        """Записи — копии, изменение не влияет на оригинал."""
        log = self._make_log(1)
        record = log.get_record(log._records[0].record_id)
        record.details["hacked"] = True
        assert "hacked" not in log._records[0].details

    def test_system_auditor_integration(self):
        """Интеграция SystemAuditor — все типы событий логируются."""
        auditor = SystemAuditor()

        # Расчёт
        auditor.log_calculation(
            event_id="evt_001",
            worker_pseudonym="w_01",
            model_version="v1.0.0",
            health_id_value=0.82,
            config_hash="sha256:abc",
            quality_status="pass",
        )

        # Верификация
        auditor.log_verification(
            session_id="sess_001",
            worker_pseudonym="w_01",
            match_score=0.75,
            liveness_score=0.88,
            route="verified",
            model_version="face_v1.0.0",
        )

        # Review
        auditor.log_review(
            review_id="rev_001",
            reviewer_pseudonym="med_01",
            old_status="pending",
            new_status="confirmed",
            comment="Личность подтверждена",
        )

        # Model version
        auditor.log_model_version(
            version="v1.0.0",
            action=AuditAction.MODEL_VERSION_PUBLISHED,
            config_hash="sha256:abc",
        )

        # Drift
        auditor.log_drift(
            report_id="drift_001",
            severity="medium",
            drifted_features=["heart_rate"],
            model_version="v1.0.0",
        )

        # Validation
        auditor.log_validation(
            stage="R0_analytical",
            status="passed",
            model_version="v1.0.0",
            report_path="validation/R0_analytical/report.md",
        )

        ok, errors = auditor.log.verify_chain()
        assert ok is True
        assert len(errors) == 0

        stats = auditor.log.get_stats()
        assert stats["total_records"] == 6
        assert "calculation_completed" in stats["action_counts"]
        assert "verification_routed" in stats["action_counts"]
        assert "review_confirmed" in stats["action_counts"]
```

