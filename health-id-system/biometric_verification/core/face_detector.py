"""Детектор лица: Haar cascade + fallback на цвет кожи."""
from __future__ import annotations
import cv2, numpy as np
from dataclasses import dataclass
from typing import Any

@dataclass
class FaceBox:
    x: int; y: int; w: int; h: int
    confidence: float = 1.0
    yaw: float = 0.0; pitch: float = 0.0; roll: float = 0.0
    occlusion_pct: float = 0.0

class HaarFaceDetector:
    def __init__(self):
        self._cascade = None
        for p in [
            cv2.data.haarcascades + "haarcascade_frontalface_default.xml",
            cv2.data.haarcascades + "haarcascade_frontalface_alt2.xml",
        ]:
            try:
                c = cv2.CascadeClassifier(p)
                if not c.empty():
                    self._cascade = c
                    break
            except Exception:
                pass

    def detect(self, frame: np.ndarray) -> list[FaceBox]:
        if self._cascade is None:
            return []
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = self._cascade.detectMultiScale(gray, 1.3, 5,
            minSize=(30, 30), flags=cv2.CASCADE_SCALE_IMAGE)
        return [FaceBox(x=int(x), y=int(y), w=int(w), h=int(h)) for x, y, w, h in faces]

class SkinColorDetector:
    def detect(self, frame: np.ndarray) -> list[FaceBox]:
        ycrcb = cv2.cvtColor(frame, cv2.COLOR_BGR2YCrCb)
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        h, w = frame.shape[:2]
        # Расширенный диапазон YCrCb
        mask_ycrcb = cv2.inRange(ycrcb, (0, 130, 75), (255, 180, 140))
        # HSV диапазон для кожи
        mask_hsv = cv2.inRange(hsv, (0, 30, 50), (30, 180, 255))
        mask = cv2.bitwise_and(mask_ycrcb, mask_hsv)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        results = []
        for c in contours:
            area = cv2.contourArea(c)
            if area < 500:
                continue
            x, y, fw, fh = cv2.boundingRect(c)
            if fw < 30 or fh < 30 or fw * fh < 900:
                continue
            results.append(FaceBox(x=x, y=y, w=fw, h=fh, confidence=float(area / (fw * fh))))
        return results

class FaceDetectorFactory:
    @staticmethod
    def create(backend: str = "haar") -> Any:
        if backend == "haar":
            d = HaarFaceDetector()
            if d._cascade is not None:
                return d
            return SkinColorDetector()
        elif backend == "skin":
            return SkinColorDetector()
        else:
            return SkinColorDetector()
