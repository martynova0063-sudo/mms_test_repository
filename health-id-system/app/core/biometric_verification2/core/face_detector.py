"""
Обнаружение лица на кадре.
Поддерживаемые бэкенды: Haar cascade, MTCNN, MediaPipe.
"""
from __future__ import annotations

import cv2
import numpy as np
from dataclasses import dataclass
from typing import Any


@dataclass
class DetectedFace:
    """Результат обнаружения лица на одном кадре."""

    x: int
    y: int
    w: int
    h: int
    confidence: float = 1.0
    yaw: float = 0.0
    pitch: float = 0.0
    roll: float = 0.0
    occlusion_pct: float = 0.0

    @property
    def area(self) -> int:
        return self.w * self.h

    def to_dict(self) -> dict[str, Any]:
        return {
            "x": self.x, "y": self.y, "w": self.w, "h": self.h,
            "confidence": self.confidence,
            "yaw": self.yaw, "pitch": self.pitch, "roll": self.roll,
            "occlusion_pct": self.occlusion_pct,
        }


class HaarFaceDetector:
    """Haar cascade — встроенный в OpenCV, не требует внешних моделей."""

    def __init__(
        self,
        scale_factor: float = 1.1,
        min_neighbors: int = 5,
        min_size: int = 64,
    ):
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        self.cascade = cv2.CascadeClassifier(cascade_path)
        if self.cascade.empty():
            raise RuntimeError(
                f"Не удалось загрузить Haar cascade: {cascade_path}. "
                "Установите opencv-contrib-python или скачайте XML вручную."
            )
        self.scale_factor = scale_factor
        self.min_neighbors = min_neighbors
        self.min_size = (min_size, min_size)

        eye_path = cv2.data.haarcascades + "haarcascade_eye.xml"
        self.eye_cascade = cv2.CascadeClassifier(eye_path)

    def detect(self, frame: np.ndarray) -> list[DetectedFace]:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        rects = self.cascade.detectMultiScale(
            gray,
            scaleFactor=self.scale_factor,
            minNeighbors=self.min_neighbors,
            minSize=self.min_size,
            flags=cv2.CASCADE_SCALE_IMAGE,
        )

        faces: list[DetectedFace] = []
        for (x, y, w, h) in rects:
            face = DetectedFace(x=int(x), y=int(y), w=int(w), h=int(h))

            if not self.eye_cascade.empty():
                roi_gray = gray[y : y + h, x : x + w]
                eyes = self.eye_cascade.detectMultiScale(roi_gray, 1.1, 5)
                if len(eyes) >= 2:
                    eyes = sorted(eyes, key=lambda e: e[0])
                    left_eye, right_eye = eyes[0], eyes[1]
                    dx = right_eye[0] - left_eye[0]
                    dy = right_eye[1] - left_eye[1]
                    face.roll = float(np.degrees(np.arctan2(dy, dx)))

            faces.append(face)

        return faces


class MTCNNFaceDetector:
    """MTCNN через facenet-pytorch (если установлен)."""

    def __init__(self, min_size: int = 64):
        try:
            from facenet_pytorch import MTCNN
            self.detector = MTCNN(
                keep_all=True,
                min_face_size=min_size,
                post_process=False,
            )
        except ImportError:
            raise ImportError(
                "facenet-pytorch не установлен. Установите: pip install facenet-pytorch"
            )

    def detect(self, frame: np.ndarray) -> list[DetectedFace]:
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        boxes, probs = self.detector.detect(rgb)

        faces: list[DetectedFace] = []
        if boxes is None:
            return faces

        for i, box in enumerate(boxes):
            x1, y1, x2, y2 = [int(v) for v in box]
            faces.append(DetectedFace(
                x=x1, y=y1, w=x2 - x1, h=y2 - y1,
                confidence=float(probs[i]) if probs is not None else 1.0,
            ))
        return faces


class MediaPipeFaceDetector:
    """MediaPipe Face Detection (если установлен)."""

    def __init__(self, min_detection_confidence: float = 0.5):
        try:
            import mediapipe as mp
            self.mp_face_detection = mp.solutions.face_detection
            self.detector = self.mp_face_detection.FaceDetection(
                min_detection_confidence=min_detection_confidence,
            )
        except ImportError:
            raise ImportError(
                "mediapipe не установлен. Установите: pip install mediapipe"
            )

    def detect(self, frame: np.ndarray) -> list[DetectedFace]:
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = self.detector.process(rgb)

        faces: list[DetectedFace] = []
        if results.detections:
            h_img, w_img = frame.shape[:2]
            for det in results.detections:
                bbox = det.location_data.relative_bounding_box
                x = max(0, int(bbox.xmin * w_img))
                y = max(0, int(bbox.ymin * h_img))
                w = int(bbox.width * w_img)
                h = int(bbox.height * h_img)
                faces.append(DetectedFace(
                    x=x, y=y, w=w, h=h,
                    confidence=float(det.score[0]),
                ))
        return faces

    def __del__(self):
        if hasattr(self, "detector"):
            self.detector.close()


def get_face_detector(backend: str = "haar", **kwargs: Any):
    """Фабрика детекторов лица."""
    detectors = {
        "haar": HaarFaceDetector,
        "mtcnn": MTCNNFaceDetector,
        "mediapipe": MediaPipeFaceDetector,
    }
    if backend not in detectors:
        raise ValueError(f"Неизвестный детектор: {backend}. Доступные: {list(detectors)}")
    return detectors[backend](**kwargs)
