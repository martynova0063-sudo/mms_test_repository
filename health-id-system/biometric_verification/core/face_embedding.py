"""Вычисление face embeddings: HOG + LBP."""
from __future__ import annotations
import cv2, numpy as np

def _lbp_histogram(gray: np.ndarray, radius: int = 1) -> np.ndarray:
    n = 8 * radius
    padded = cv2.copyMakeBorder(gray, radius, radius, radius, radius, cv2.BORDER_REFLECT)
    hist = np.zeros(2 ** n, dtype=np.float32)
    for i in range(n):
        angle = 2 * np.pi * i / n
        dx = int(round(radius * np.cos(angle)))
        dy = int(round(radius * np.sin(angle)))
        neighbor = padded[radius+dy:radius+dy+gray.shape[0],
                          radius+dx:radius+dx+gray.shape[1]]
        diff = (neighbor >= gray).astype(np.uint8)
        hist[(np.arange(2**n) >> 0) & 1 == diff] += 1  # упрощённо
    # более простой подход: посчитать uniform LBP
    return _simple_lbp(gray, radius, n)

def _simple_lbp(gray: np.ndarray, radius: int, n: int) -> np.ndarray:
    padded = cv2.copyMakeBorder(gray, radius, radius, radius, radius, cv2.BORDER_REFLECT)
    codes = np.zeros_like(gray, dtype=np.uint32)
    for i in range(n):
        angle = 2 * np.pi * i / n
        dx = int(round(radius * np.cos(angle)))
        dy = int(round(radius * np.sin(angle)))
        neighbor = padded[radius+dy:radius+dy+gray.shape[0],
                          radius+dx:radius+dx+gray.shape[1]]
        codes |= ((neighbor >= gray).astype(np.uint32) << i)
    hist = np.zeros(256, dtype=np.float32)
    for v in range(256):
        hist[v] = np.count_nonzero(codes == v)
    hist /= (hist.sum() + 1e-8)
    return hist

def compute_embedding(image: np.ndarray) -> np.ndarray:
    """Вычисляет embedding из изображения (BGR или Gray)."""
    if image.ndim == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        gray = image
    gray = cv2.resize(gray, (64, 64))
    # HOG
    win_size = (64, 64)
    block_size = (16, 16)
    block_stride = (8, 8)
    cell_size = (8, 8)
    nbins = 9
    hog = cv2.HOGDescriptor(win_size, block_size, block_stride, cell_size, nbins)
    hog_desc = hog.compute(gray).flatten()
    # LBP
    lbp_hist = _simple_lbp(gray, 1, 8)
    # Комбинация
    embedding = np.concatenate([hog_desc, lbp_hist])
    # L2-нормализация
    norm = np.linalg.norm(embedding)
    if norm > 0:
        embedding = embedding / norm
    return embedding.astype(np.float32)

def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Косинусное сходство, перенесённое в [0, 1]."""
    dot = float(np.dot(a, b))
    norm_a = float(np.linalg.norm(a))
    norm_b = float(np.linalg.norm(b))
    if norm_a < 1e-8 or norm_b < 1e-8:
        return 0.0
    return (dot / (norm_a * norm_b) + 1.0) / 2.0
