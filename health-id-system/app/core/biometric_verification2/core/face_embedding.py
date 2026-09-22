"""
Извлечение векторного представления лица (face embedding).

Реализованы два подхода:
1. hog_lbp — HOG + LBP фичи на основе OpenCV (без внешних моделей).
2. dlib / facenet — обёртки над внешними библиотеками (если установлены).
"""
from __future__ import annotations

import cv2
import numpy as np
from typing import Any

from biometric_verification.core.face_detector import DetectedFace


class HOGLBPEmbedder:
    """
    HOG + LBP эмбеддинг без внешних зависимостей.

    Конвейер:
      1. Вырезать ROI лица с padding.
      2. Привести к фиксированному размеру.
      3. Перевести в grayscale.
      4. Вычислить HOG (Histogram of Oriented Gradients).
      5. Вычислить LBP (Local Binary Pattern) гистограмму.
      6. Нормализовать и конкатенировать.
    """

    def __init__(
        self,
        face_size: tuple[int, int] = (128, 128),
        padding: int = 20,
    ):
        self.face_size = face_size
        self.padding = padding

        self.hog = cv2.HOGDescriptor(
            _winSize=face_size,
            _blockSize=(16, 16),
            _blockStride=(8, 8),
            _cellSize=(8, 8),
            _nbins=9,
        )

        self.lbp_radius = 2
        self.lbp_points = 8 * self.lbp_radius
        self.lbp_grid_x = 8
        self.lbp_grid_y = 8

    def extract(self, frame: np.ndarray, face: DetectedFace) -> np.ndarray | None:
        """Извлечь embedding из ROI лица на кадре."""
        h_img, w_img = frame.shape[:2]

        x1 = max(0, face.x - self.padding)
        y1 = max(0, face.y - self.padding)
        x2 = min(w_img, face.x + face.w + self.padding)
        y2 = min(h_img, face.y + face.h + self.padding)

        roi = frame[y1:y2, x1:x2]
        if roi.size == 0:
            return None

        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        gray = cv2.resize(gray, self.face_size, interpolation=cv2.INTER_CUBIC)

        hog_vec = self.hog.compute(gray)
        if hog_vec is None:
            return None
        hog_vec = hog_vec.flatten()

        lbp = self._compute_lbp(gray)
        lbp_hist = self._compute_lbp_histogram(lbp)

        embedding = np.concatenate([hog_vec, lbp_hist])
        norm = np.linalg.norm(embedding)
        if norm > 0:
            embedding = embedding / norm

        return embedding.astype(np.float32)

    def extract_from_image(self, image: np.ndarray) -> np.ndarray | None:
        """Извлечь embedding из уже обрезанного изображения лица."""
        if image.ndim == 3:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        else:
            gray = image
        gray = cv2.resize(gray, self.face_size, interpolation=cv2.INTER_CUBIC)

        hog_vec = self.hog.compute(gray)
        if hog_vec is None:
            return None
        hog_vec = hog_vec.flatten()

        lbp = self._compute_lbp(gray)
        lbp_hist = self._compute_lbp_histogram(lbp)

        embedding = np.concatenate([hog_vec, lbp_hist])
        norm = np.linalg.norm(embedding)
        if norm > 0:
            embedding = embedding / norm

        return embedding.astype(np.float32)

    def _compute_lbp(self, gray: np.ndarray) -> np.ndarray:
        """Вычислить LBP карту."""
        radius = self.lbp_radius
        points = self.lbp_points

        h, w = gray.shape
        lbp = np.zeros((h, w), dtype=np.float32)

        for p in range(points):
            angle = 2 * np.pi * p / points
            dx = int(round(radius * np.cos(angle)))
            dy = int(round(radius * np.sin(angle)))

            shifted = np.zeros_like(gray, dtype=np.float32)
            y_src_start = max(0, dy)
            y_src_end = min(h, h + dy)
            x_src_start = max(0, dx)
            x_src_end = min(w, w + dx)

            y_dst_start = max(0, -dy)
            y_dst_end = min(h, h - dy)
            x_dst_start = max(0, -dx)
            x_dst_end = min(w, w - dx)

            shifted[y_dst_start:y_dst_end, x_dst_start:x_dst_end] = (
                gray[y_src_start:y_src_end, x_src_start:x_src_end].astype(np.float32)
            )

            mask = shifted[y_dst_start:y_dst_end, x_dst_start:x_dst_end] >= (
                gray[y_dst_start:y_dst_end, x_dst_start:x_dst_end].astype(np.float32)
            )
            lbp[y_dst_start:y_dst_end, x_dst_start:x_dst_end] += (
                mask.astype(np.float32) * (1 << p)
            )

        return lbp

    def _compute_lbp_histogram(self, lbp: np.ndarray) -> np.ndarray:
        """Гистограмма LBP по сетке регионов."""
        h, w = lbp.shape
        cell_h = h // self.lbp_grid_y
        cell_w = w // self.lbp_grid_x
        n_bins = 2 ** self.lbp_points

        hist_parts: list[np.ndarray] = []
        for i in range(self.lbp_grid_y):
            for j in range(self.lbp_grid_x):
                cell = lbp[
                    i * cell_h : (i + 1) * cell_h,
                    j * cell_w : (j + 1) * cell_w,
                ]
                hist, _ = np.histogram(cell.ravel(), bins=n_bins, range=(0, n_bins))
                hist = hist.astype(np.float32)
                s = hist.sum()
                if s > 0:
                    hist /= s
                hist_parts.append(hist)

        return np.concatenate(hist_parts)


class DlibEmbedder:
    """Dlib ResNet face embedding (128D / 192D)."""

    def __init__(self, model_path: str, predictor_path: str):
        try:
            import dlib
        except ImportError:
            raise ImportError("dlib не установлен: pip install dlib")

        self.detector = dlib.get_frontal_face_detector()
        self.predictor = dlib.shape_predictor(predictor_path)
        self.recognizer = dlib.face_recognition_model_v1(model_path)

    def extract(self, frame: np.ndarray, face: DetectedFace) -> np.ndarray | None:
        import dlib

        rect = dlib.rectangle(face.x, face.y, face.x + face.w, face.y + face.h)
        shape = self.predictor(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB), rect)
        embedding = np.array(
            self.recognizer.compute_face_descriptor(
                cv2.cvtColor(frame, cv2.COLOR_BGR2RGB), shape
            )
        )
        return embedding.astype(np.float32)


class FaceNetEmbedder:
    """FaceNet (facenet-pytorch) 512D embedding."""

    def __init__(self):
        try:
            from facenet_pytorch import InceptionResnetV1
            import torch
        except ImportError:
            raise ImportError("facenet-pytorch не установлен")

        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model = InceptionResnetV1(pretrained="vggface2").eval().to(self.device)
        self.face_size = (160, 160)

    def extract(self, frame: np.ndarray, face: DetectedFace) -> np.ndarray | None:
        import torch
        from torchvision.transforms import functional as F

        x1, y1 = face.x, face.y
        x2, y2 = face.x + face.w, face.y + face.h
        roi = frame[y1:y2, x1:x2]
        if roi.size == 0:
            return None

        rgb = cv2.cvtColor(roi, cv2.COLOR_BGR2RGB)
        resized = cv2.resize(rgb, self.face_size)
        tensor = F.to_tensor(resized).unsqueeze(0).to(self.device)

        with torch.no_grad():
            embedding = self.model(tensor).cpu().numpy().flatten()

        norm = np.linalg.norm(embedding)
        if norm > 0:
            embedding = embedding / norm
        return embedding.astype(np.float32)


def get_embedder(method: str = "hog_lbp", **kwargs: Any):
    """Фабрика эмбеддеров."""
    embedders = {
        "hog_lbp": HOGLBPEmbedder,
        "dlib": DlibEmbedder,
        "facenet": FaceNetEmbedder,
    }
    if method not in embedders:
        raise ValueError(f"Неизвестный эмбеддер: {method}. Доступные: {list(embedders)}")
    return embedders[method](**kwargs)
