"""Модуль 4.1.2 — Liveness Detection."""
from __future__ import annotations
import cv2, numpy as np
from dataclasses import dataclass, field
from typing import Any
from .face_detector import FaceDetectorFactory, FaceBox
from ..config.settings import ModelConfig
from enum import Enum

class LivenessDecisionEnum(str, Enum):
    LIVE = "live"
    SPOOF_DETECTED = "spoof_detected"
    INCONCLUSIVE = "inconclusive"

class AttackType(str, Enum):
    NONE = "none"
    PHOTO_PRINT = "photo_print"
    SCREEN_REPLAY = "screen_replay"
    VIDEO_REPLAY = "video_replay"
    MASK_3D = "mask_3d"

@dataclass
class LivenessSignal:
    score: float
    passed: bool
    details: dict = field(default_factory=dict)

@dataclass
class LivenessOutput:
    liveness_score: float
    liveness_signals: dict[str, LivenessSignal]
    decision: str
    evidence_frames: list[int] = field(default_factory=list)
    attack_type: str = "none"

def _compute_blink_signal(frames_gray, face_boxes, config):
    if len(frames_gray) < 3:
        return LivenessSignal(0.5, True, {"reason": "too_few_frames"})
    ear_values = []
    for i, (gray, box) in enumerate(zip(frames_gray, face_boxes)):
        if box is None or gray is None:
            continue
        h, w = gray.shape[:2]
        eye_y1 = max(0, box.y + int(box.h * 0.25))
        eye_y2 = min(h, box.y + int(box.h * 0.45))
        eye_x1 = max(0, box.x + int(box.w * 0.15))
        eye_x2 = min(w, box.x + int(box.w * 0.85))
        eye_region = gray[eye_y1:eye_y2, eye_x1:eye_x2]
        if eye_region.size == 0:
            continue
        gx = cv2.Sobel(eye_region, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(eye_region, cv2.CV_32F, 0, 1, ksize=3)
        mag = np.sqrt(gx**2 + gy**2)
        ear_values.append(float(np.mean(mag)))
    if len(ear_values) < 3:
        return LivenessSignal(0.5, True, {"reason": "insufficient_eye_data"})
    ear_arr = np.array(ear_values)
    diffs = np.abs(np.diff(ear_arr))
    blinks = int(np.sum(diffs > np.std(ear_arr) * config.blink_min_ratio))
    score = min(1.0, blinks / max(1, config.blink_min_count))
    passed = blinks >= config.blink_min_count
    return LivenessSignal(score, passed, {"blink_count": blinks, "ear_values": [float(x) for x in ear_values[:10]]})

def _compute_head_motion(frames_gray, face_boxes, config):
    if len(frames_gray) < 3:
        return LivenessSignal(0.5, True, {"reason": "too_few_frames"})
    motions = []
    for i in range(1, len(face_boxes)):
        if face_boxes[i] is None or face_boxes[i-1] is None:
            continue
        dx = abs(face_boxes[i].x - face_boxes[i-1].x)
        dy = abs(face_boxes[i].y - face_boxes[i-1].y)
        dw = abs(face_boxes[i].w - face_boxes[i-1].w)
        dh = abs(face_boxes[i].h - face_boxes[i-1].h)
        motion = dx + dy + dw + dh
        motions.append(motion)
    motion_frames = sum(1 for m in motions if m > 3)
    score = min(1.0, motion_frames / max(1, config.head_motion_min_frames))
    passed = motion_frames >= config.head_motion_min_frames
    return LivenessSignal(score, passed, {"motion_frames": motion_frames, "total_frames": len(motions)})

def _compute_texture_signal(frames_gray, face_boxes, config):
    if not frames_gray or face_boxes[0] is None:
        return LivenessSignal(0.5, True, {"reason": "no_face"})
    scores = []
    fft_peaks = []
    for gray, box in zip(frames_gray, face_boxes):
        if box is None:
            continue
        crop = gray[box.y:box.y+box.h, box.x:box.x+box.w]
        if crop.size == 0:
            continue
        crop = cv2.resize(crop, (64, 64))
        # LBP entropy
        lbp = _simple_lbp(crop)
        hist = np.bincount(lbp.ravel(), minlength=256).astype(float)
        hist /= (hist.sum() + 1e-8)
        entropy = -np.sum(hist * np.log2(hist + 1e-8))
        lbp_score = min(1.0, entropy / 8.0)
        # FFT
        f = np.fft.fft2(crop.astype(float))
        f_shift = np.fft.fftshift(f)
        mag = np.abs(f_shift)
        radial = _radial_profile(mag)
        peak_ratio = float(np.max(radial[3:]) / (np.mean(radial) + 1e-8))
        fft_peaks.append(peak_ratio)
        scores.append(lbp_score)
    if not scores:
        return LivenessSignal(0.5, True, {"reason": "no_data"})
    avg_lbp = float(np.mean(scores))
    avg_fft = float(np.mean(fft_peaks)) if fft_peaks else 0.0
    # Низкая текстура = спуфинг
    texture_pass = avg_lbp >= config.texture_lbp_threshold
    fft_suspicious = avg_fft > config.texture_freq_threshold
    score = avg_lbp * (0.6 if fft_suspicious else 1.0)
    return LivenessSignal(score, texture_pass, {"lbp_entropy": avg_lbp, "fft_peak_ratio": avg_fft, "fft_suspicious": fft_suspicious})

def _simple_lbp(gray):
    padded = cv2.copyMakeBorder(gray, 1, 1, 1, 1, cv2.BORDER_REFLECT)
    codes = np.zeros_like(gray, dtype=np.uint8)
    for i, (dy, dx) in enumerate([(-1,-1),(-1,0),(-1,1),(0,1),(1,1),(1,0),(1,-1),(0,-1)]):
        codes |= ((padded[1+dy:1+dy+gray.shape[0], 1+dx:1+dx+gray.shape[1]] >= gray).astype(np.uint8) << i)
    return codes

def _radial_profile(mag):
    h, w = mag.shape
    cy, cx = h//2, w//2
    y, x = np.ogrid[:h, :w]
    r = np.sqrt((x-cx)**2 + (y-cy)**2).astype(int)
    rmax = min(cy, cx)
    profile = np.zeros(rmax+1)
    for ri in range(rmax+1):
        mask = r == ri
        if mask.any():
            profile[ri] = mag[mask].mean()
    return profile

def _compute_depth_signal(frames_gray, face_boxes, config):
    if len(frames_gray) < 3:
        return LivenessSignal(0.5, True, {"reason": "too_few_frames"})
    face_flows = []
    bg_flows = []
    for i in range(1, len(frames_gray)):
        if frames_gray[i] is None or frames_gray[i-1] is None:
            continue
        flow = cv2.calcOpticalFlowFarneback(frames_gray[i-1], frames_gray[i], None,
                                            0.5, 3, 15, 3, 5, 1.2, 0)
        mag = np.sqrt(flow[:,:,0]**2 + flow[:,:,1]**2)
        box = face_boxes[i]
        if box is not None:
            face_mag = float(np.mean(mag[box.y:box.y+box.h, box.x:box.x+box.w]))
            bg_mag = float(np.mean(mag))
            face_flows.append(face_mag)
            bg_flows.append(bg_mag)
    if len(face_flows) < 2:
        return LivenessSignal(0.5, True, {"reason": "insufficient_flow"})
    diff = np.array(face_flows) - np.array(bg_flows)
    parallax = float(np.std(diff))
    # Настоящее лицо должно иметь больший параллакс
    score = min(1.0, parallax / 2.0)
    return LivenessSignal(score, score > 0.3, {"parallax": parallax, "face_flow": float(np.mean(face_flows))})

def _classify_attack(blink, motion, texture, depth):
    if not blink.passed and not motion.passed and not texture.passed:
        return AttackType.PHOTO_PRINT
    if not blink.passed and motion.passed and not texture.passed:
        return AttackType.SCREEN_REPLAY
    if blink.passed and motion.passed and not texture.passed:
        return AttackType.VIDEO_REPLAY
    if blink.passed and motion.passed and texture.passed and not depth.passed:
        return AttackType.MASK_3D
    return AttackType.NONE

def run_liveness_detection(video_path: str, config: ModelConfig) -> LivenessOutput:
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return LivenessOutput(0.0, {}, LivenessDecisionEnum.INCONCLUSIVE.value)
    detector = FaceDetectorFactory.create(config.detector_backend)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    sample_interval = max(1, int(fps * config.frame_sample_interval / 30))

    frames_gray = []
    face_boxes = []
    evidence_frames = []
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
                box = max(faces, key=lambda f: f.w * f.h)
                frames_gray.append(gray)
                face_boxes.append(box)
                processed += 1
            else:
                if len(frames_gray) > 0:
                    frames_gray.append(gray)
                    face_boxes.append(None)
        frame_id += 1
    cap.release()

    if len(frames_gray) < 3:
        return LivenessOutput(0.0, {"reason": LivenessSignal(0.0, False, {"reason": "too_few_frames"})},
                              LivenessDecisionEnum.INCONCLUSIVE.value, evidence_frames)

    blink = _compute_blink_signal(frames_gray, face_boxes, config)
    motion = _compute_head_motion(frames_gray, face_boxes, config)
    texture = _compute_texture_signal(frames_gray, face_boxes, config)
    depth = _compute_depth_signal(frames_gray, face_boxes, config) if config.depth_enabled else LivenessSignal(0.5, True, {"reason": "disabled"})

    score = (blink.score * config.blink_weight + motion.score * config.head_motion_weight +
             texture.score * config.texture_weight + depth.score * config.depth_weight)

    attack = _classify_attack(blink, motion, texture, depth)
    if attack != AttackType.NONE:
        evidence_frames = list(range(0, len(frames_gray), max(1, len(frames_gray)//5)))

    if score >= config.liveness_pass:
        decision = LivenessDecisionEnum.LIVE.value
    elif score < config.liveness_fail or texture.score < 0.3 or blink.score < 0.15:
        decision = LivenessDecisionEnum.SPOOF_DETECTED.value
    else:
        decision = LivenessDecisionEnum.INCONCLUSIVE.value

    return LivenessOutput(
        liveness_score=round(score, 4),
        liveness_signals={"blink": blink, "head_motion": motion, "texture": texture, "depth": depth},
        decision=decision, evidence_frames=evidence_frames[:20],
        attack_type=attack.value,
    )
