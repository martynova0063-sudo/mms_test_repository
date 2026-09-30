"""
liveness_ensemble.py — ансамбль двух методов liveness:
  1. rPPG (remote photoplethysmography) — анализ микром changes цвета кожи
  2. Siamese network — сравнение кадра с эталоном

Стратегия: оба метода дают независимую оценку, ансамбль комбинирует.
"""

import numpy as np
import cv2
from typing import Optional
from dataclasses import dataclass


@dataclass
class LivenessResult:
    is_live: bool
    liveness_score: float  # финальный score ансамбля (0..1)
    method: str  # "ensemble"
    rppg_score: Optional[float] = None
    siamese_score: Optional[float] = None
    rppg_detail: Optional[dict] = None
    siamese_detail: Optional[dict] = None
    decision_rule: str = ""  # как было принято решение


# ──────────────────────────────────────────────
# rPPG-модуль (упрощённая версия)
# ──────────────────────────────────────────────

class RPPGLiveness:
    """
    rPPG liveness: анализ пульсовой волны по микром changes цвета кожи.

    Принцип:
      1. Извлекаем ROI (лоб, щёки) с нескольких кадров
      2. Считаем средний сигнал по каждому каналу (R, G, B)
      3. Анализируем частотный спектр (FFT) зелёного канала
      4. Живое лицо → пик в диапазоне 0.8–3.0 Гц (48–180 уд/мин)
      5. Подмена → нет выраженного пика или хаотичный спектр
    """

    def __init__(
        self,
        fps: float = 30.0,
        min_hr: float = 0.8,   # 48 уд/мин
        max_hr: float = 3.0,  # 180 уд/мин
        min_confidence: float = 0.3,
    ):
        self.fps = fps
        self.min_hr = min_hr
        self.max_hr = max_hr
        self.min_confidence = min_confidence

    def _extract_skin_roi(self, frame: np.ndarray) -> np.ndarray:
        """Извлечение области кожи (упрощённо: центр кадра)."""
        h, w = frame.shape[:2]
        # Верхняя половина лица: лоб + переносица
        roi = frame[int(h * 0.1):int(h * 0.45), int(w * 0.2):int(w * 0.8)]
        return roi

    def check_video(
        self,
        video_path: str,
        sample_every_n_frames: int = 3,
        min_frames: int = 30,
    ) -> dict:
        """
        Анализ rPPG по видео.

        Returns:
            {
                "is_live": bool,
                "liveness_score": float,  # 0..1
                "hr_estimate": float,      # оценочная ЧСС (Гц)
                "snr": float,              # signal-to-noise ratio
                "num_frames": int,
                "error": Optional[str],
            }
        """
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return {"is_live": False, "liveness_score": 0.0, "error": "cannot_open"}

        fps = cap.get(cv2.CAP_PROP_FPS) or self.fps

        green_signal = []
        frame_count = 0

        while True:
            ret, frame = cap.read()
            if not ret:
                break

            if frame_count % sample_every_n_frames == 0:
                roi = self._extract_skin_roi(frame)
                # Средний зелёный канал ROI
                green_mean = np.mean(roi[:, :, 1])  # G канал в BGR
                green_signal.append(green_mean)

            frame_count += 1

        cap.release()

        if len(green_signal) < min_frames:
            return {
                "is_live": False,
                "liveness_score": 0.0,
                "num_frames": len(green_signal),
                "error": "too_short",
            }

        signal = np.array(green_signal, dtype=np.float32)
        # Центрируем
        signal = signal - np.mean(signal)
        # Нормализуем
        if np.std(signal) > 0:
            signal = signal / np.std(signal)

        # FFT для поиска пульсовой частоты
        fft = np.fft.rfft(signal)
        fft_mag = np.abs(fft)
        freqs = np.fft.rfftfreq(len(signal), d=1.0 / fps)

        # Ищем пик в физиологическом диапазоне
        valid_mask = (freqs >= self.min_hr) & (freqs <= self.max_hr)
        if not np.any(valid_mask):
            return {
                "is_live": False,
                "liveness_score": 0.0,
                "num_frames": len(signal),
                "error": "no_valid_freq_range",
            }

        valid_mags = fft_mag[valid_mask]
        valid_freqs = freqs[valid_mask]

        peak_idx = np.argmax(valid_mags)
        peak_freq = valid_freqs[peak_idx]
        peak_mag = valid_mags[peak_idx]

        # SNR: пик / медиана остального спектра
        other_mags = np.delete(fft_mag, np.where(valid_mask))
        noise_level = np.median(other_mags) if len(other_mags) > 0 else 1.0
        snr = float(peak_mag / (noise_level + 1e-8))

        # Score: чем выше SNR — тем выше уверенность
        # Нормируем: SNR > 3 → сильный сигнал, SNR < 1 → нет сигнала
        score = float(np.clip(snr / 3.0, 0.0, 1.0))

        is_live = score >= self.min_confidence and snr > 1.0

        return {
            "is_live": is_live,
            "liveness_score": score,
            "hr_estimate": float(peak_freq * 60),  # в уд/мин
            "snr": snr,
            "num_frames": len(signal),
            "error": None,
        }


# ──────────────────────────────────────────────
# Ансамбль
# ──────────────────────────────────────────────

class LivenessEnsemble:
    """
    Ансамбль rPPG + Siamese для liveness-проверки.

    Стратегии принятия решений:
      - "weighted_avg": взвешенное среднее двух scores
      - "and": оба должны сказать "live"
      - "or": достаточно одного "live"
      - "adaptive": если видео короткое (< 3 сек) — доверяем сиамской,
                    если длинное — доверяем rPPG
    """

    def __init__(
        self,
        siamese_checker,  # SiameseLivenessChecker из предыдущего модуля
        rppg_checker: Optional[RPPGLiveness] = None,
        strategy: str = "adaptive",
        siamese_weight: float = 0.4,
        rppg_weight: float = 0.6,
        threshold: float = 0.5,
    ):
        self.siamese = siamese_checker
        self.rppg = rppg_checker or RPPGLiveness()
        self.strategy = strategy
        self.siamese_weight = siamese_weight
        self.rppg_weight = rppg_weight
        self.threshold = threshold

    def check(
        self,
        video_path: str,
        reference_frame: np.ndarray,
    ) -> LivenessResult:
        """
        Запускает оба метода и комбинирует результат.

        Args:
            video_path: путь к проверяемому видео
            reference_frame: эталонный кадр живого лица (для сиамской сети)

        Returns:
            LivenessResult с финальным решением и детализацией
        """
        # --- 1. Siamese ---
        siamese_detail = self.siamese.check_video(
            video_path=video_path,
            reference_frame=reference_frame,
            sample_every_n_frames=10,
        )
        siamese_score = siamese_detail.get("liveness_score", 0.0)
        siamese_live = siamese_detail.get("is_live", False)

        # --- 2. rPPG ---
        rppg_detail = self.rppg.check_video(video_path)
        rppg_score = rppg_detail.get("liveness_score", 0.0)
        rppg_live = rppg_detail.get("is_live", False)

        # Если rPPG не смог отработать (короткое видео) — корректируем веса
        rppg_error = rppg_detail.get("error")
        video_too_short = rppg_error in ("too_short", "no_frames_extracted")

        # --- 3. Комбинируем ---
        if self.strategy == "weighted_avg":
            final_score, decision = self._weighted_avg(
                siamese_score, rppg_score, siamese_live, rppg_live, video_too_short
            )

        elif self.strategy == "and":
            final_score = (siamese_score + rppg_score) / 2
            decision = siamese_live and rppg_live
            decision_rule = "both must agree (AND)"

        elif self.strategy == "or":
            final_score = max(siamese_score, rppg_score)
            decision = siamese_live or rppg_live
            decision_rule = "either can pass (OR)"

        elif self.strategy == "adaptive":
            final_score, decision, decision_rule = self._adaptive(
                siamese_score, rppg_score, siamese_live, rppg_live,
                video_too_short, rppg_detail,
            )
        else:
            raise ValueError(f"Unknown strategy: {self.strategy}")

        return LivenessResult(
            is_live=decision,
            liveness_score=final_score,
            method="ensemble",
            rppg_score=rppg_score,
            siamese_score=siamese_score,
            rppg_detail=rppg_detail,
            siamese_detail=siamese_detail,
            decision_rule=decision_rule,
        )

    def _weighted_avg(
        self, s_score, r_score, s_live, r_live, rppg_failed
    ) -> tuple[float, bool]:
        """Взвешенное среднее с коррекцией при отказе rPPG."""
        if rppg_failed:
            # rPPG не сработал — доверяем только сиамской
            w_s, w_r = 1.0, 0.0
            rule = "rPPG failed → siamese only"
        else:
            w_s = self.siamese_weight
            w_r = self.rppg_weight
            rule = f"weighted avg (s={w_s}, r={w_r})"

        final = s_score * w_s + r_score * w_r
        decision = final >= self.threshold
        return final, decision

    def _adaptive(
        self, s_score, r_score, s_live, r_live, rppg_failed, rppg_detail
    ) -> tuple[float, bool, str]:
        """
        Адаптивная стратегия:
          - Короткое видео (< 3 сек, < 90 кадров): доверяем сиамской
          - Длинное видео: доверяем rPPG (он точнее на длинных)
          - Если rPPG даёт сильный сигнал (SNR > 3) — перевешивает
          - Если оба говорят "spoof" — точно spoof
        """
        num_frames = rppg_detail.get("num_frames", 0)
        snr = rppg_detail.get("snr", 0.0)

        if rppg_failed or num_frames < 30:
            # Видео слишком короткое для rPPG — доверяем сиамской
            final = s_score
            decision = s_live
            rule = "short video → siamese only"
        elif snr > 3.0:
            # rPPG даёт очень сильный сигнал — он главный
            final = r_score * 0.7 + s_score * 0.3
            decision = final >= self.threshold
            rule = f"strong rPPG (SNR={snr:.1f}) → rPPG-led"
        elif not s_live and not r_live:
            # Оба говорят "spoof" — точно spoof
            final = min(s_score, r_score)
            decision = False
            rule = "both reject → spoof"
        else:
            # Обычный случай: взвешенное
            final = s_score * self.siamese_weight + r_score * self.rppg_weight
            decision = final >= self.threshold
            rule = "default weighted avg"

        return final, decision, rule
