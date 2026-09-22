"""rPPG — извлечение витальных признаков из видео."""
from __future__ import annotations
import cv2, numpy as np
from dataclasses import dataclass, field
from typing import Any
from .face_detector import FaceDetectorFactory
from ..config.settings import ModelConfig

@dataclass
class RPPGOutput:
    heart_rate: float = 0.0
    hrv_rmssd: float = 0.0
    breathing_rate: float = 0.0
    stress_index: float = 0.0
    signal_quality: float = 0.0
    fps: float = 0.0
    duration: float = 0.0
    n_frames: int = 0
    error: str = ""

def _bandpass(signal, fs, low, high):
    from scipy.signal import butter, filtfilt
    nyq = fs / 2
    b, a = butter(2, [low/nyq, high/nyq], btype="band")
    return filtfilt(b, a, signal)

def _fft_peak(signal, fs, low, high):
    n = len(signal)
    freqs = np.fft.rfftfreq(n, d=1/fs)
    fft = np.abs(np.fft.rfft(signal))
    mask = (freqs >= low) & (freqs <= high)
    if not mask.any(): return 0.0, 0.0
    idx = np.argmax(fft[mask])
    peak_freq = freqs[mask][idx]
    peak_power = float(fft[mask][idx])
    total_power = float(np.sum(fft[mask])) + 1e-8
    snr = peak_power / total_power
    return float(peak_freq), snr

def _compute_rmssd(peaks, fs):
    if len(peaks) < 3: return 0.0
    rr = np.diff(peaks) / fs * 1000  # мс
    if len(rr) < 2: return 0.0
    return float(np.sqrt(np.mean(np.square(np.diff(rr)))))

def _compute_baevsky(peaks, fs):
    if len(peaks) < 5: return 0.5
    rr = np.diff(peaks) / fs * 1000
    mo = float(np.mean(rr))
    mxdmn = float(np.max(rr) - np.min(rr))
    amo = float(np.std(rr))
    if mo < 1e-6: return 0.5
    idx = amo / (2 * mo * mxdmn) if mxdmn > 0 else 0.5
    return float(np.clip(idx, 0, 1))

def run_rppg(video_path: str, config: ModelConfig) -> RPPGOutput:
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return RPPGOutput(error="cannot_open")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = frame_count / fps if fps > 0 else 0
    if duration < config.rppg_min_duration or fps < config.rppg_min_fps:
        cap.release()
        return RPPGOutput(fps=fps, duration=duration, n_frames=frame_count, error="too_short")

    detector = FaceDetectorFactory.create(config.detector_backend)
    green_values = []
    frame_id = 0
    max_frames = min(config.max_frames_to_process, frame_count)
    sample_step = max(1, int(fps / config.rppg_target_fps))

    while frame_id < max_frames:
        ret, frame = cap.read()
        if not ret: break
        if frame_id % sample_step == 0:
            faces = detector.detect(frame)
            if faces:
                face = max(faces, key=lambda f: f.w * f.h)
                h, w = frame.shape[:2]
                # Лоб + переносица
                roi_y1 = max(0, face.y + int(face.h * 0.08))
                roi_y2 = min(h, face.y + int(face.h * 0.30))
                roi_x1 = max(0, face.x + int(face.w * 0.25))
                roi_x2 = min(w, face.x + int(face.w * 0.75))
                roi = frame[roi_y1:roi_y2, roi_x1:roi_x2]
                if roi.size > 0:
                    green = float(np.mean(roi[:, :, 1]))
                    green_values.append(green)
        frame_id += 1
    cap.release()

    if len(green_values) < 30:
        return RPPGOutput(fps=fps, duration=duration, n_frames=frame_count, error="insufficient_signal")

    signal = np.array(green_values, dtype=np.float64)
    signal = signal - np.mean(signal)
    if np.std(signal) < 1e-6:
        return RPPGOutput(fps=fps, duration=duration, n_frames=frame_count, error="flat_signal")

    effective_fps = fps / sample_step
    try:
        filtered = _bandpass(signal, effective_fps, config.hr_band[0], config.hr_band[1])
    except Exception:
        filtered = signal

    hr_freq, hr_snr = _fft_peak(filtered, effective_fps, config.hr_band[0], config.hr_band[1])
    heart_rate = hr_freq * 60 if hr_freq > 0 else 0.0

    # Peaks
    from scipy.signal import find_peaks
    peaks, _ = find_peaks(filtered, distance=int(effective_fps * 0.4))
    hrv = _compute_rmssd(peaks, effective_fps)
    stress = _compute_baevsky(peaks, effective_fps)

    # Breathing
    try:
        br_filtered = _bandpass(signal, effective_fps, config.br_band[0], config.br_band[1])
        br_freq, _ = _fft_peak(br_filtered, effective_fps, config.br_band[0], config.br_band[1])
        breathing_rate = br_freq * 60 if br_freq > 0 else 0.0
    except Exception:
        breathing_rate = 0.0

    signal_quality = float(np.clip(hr_snr, 0, 1))

    return RPPGOutput(
        heart_rate=round(heart_rate, 1), hrv_rmssd=round(hrv, 1),
        breathing_rate=round(breathing_rate, 1), stress_index=round(stress, 4),
        signal_quality=signal_quality, fps=round(effective_fps, 1),
        duration=round(duration, 2), n_frames=len(green_values),
    )
