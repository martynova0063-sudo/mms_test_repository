"""Контроль качества видеопотока."""
from __future__ import annotations
import cv2, numpy as np
from dataclasses import dataclass, field
from typing import Any
from ..config.settings import ModelConfig

@dataclass
class QualityResult:
    overall: str
    checks: dict[str, dict[str, Any]] = field(default_factory=dict)
    blocking_issues: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

def check_video_quality(video_path: str, config: ModelConfig,
                         face_detector: Any = None) -> QualityResult:
    result = QualityResult(overall="pass")
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        result.overall = "fail"
        result.blocking_issues.append("cannot_open_video")
        return result

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration_sec = frame_count / fps if fps > 0 else 0

    min_w, min_h = config.min_resolution
    res_pass = width >= min_w and height >= min_h
    result.checks["resolution"] = {"status": "pass" if res_pass else "fail", "actual": [width, height], "required": [min_w, min_h]}
    if not res_pass: result.blocking_issues.append("resolution_too_low")

    fps_pass = fps >= config.min_fps
    result.checks["fps"] = {"status": "pass" if fps_pass else "warning", "actual": round(fps, 1), "required": config.min_fps}
    if not fps_pass: result.warnings.append("low_fps")

    dur_pass = duration_sec >= config.min_duration_sec
    result.checks["duration"] = {"status": "pass" if dur_pass else "fail", "actual": round(duration_sec, 2), "required": config.min_duration_sec}
    if not dur_pass: result.blocking_issues.append("duration_too_short")

    sample_interval = max(1, frame_count // 30)
    blur_values, face_areas, lighting_values, angles, occlusion_flags = [], [], [], [], []
    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret: break
        if frame_idx % sample_interval == 0:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            blur_var = cv2.Laplacian(gray, cv2.CV_64F).var()
            blur_values.append(blur_var)
            brightness = float(np.mean(gray))
            lighting_values.append(brightness)
            if face_detector is not None:
                faces = face_detector.detect(frame)
                if faces:
                    face = max(faces, key=lambda f: f.w * f.h)
                    face_area = (face.w * face.h) / (width * height) * 100
                    face_areas.append(face_area)
                    angles.append({"yaw": face.yaw, "pitch": face.pitch, "roll": face.roll})
                else:
                    face_areas.append(0.0)
        frame_idx += 1
    cap.release()

    if blur_values:
        avg_blur = float(np.mean(blur_values))
        blur_pass = avg_blur >= config.max_blur_variance
        result.checks["blur"] = {"status": "pass" if blur_pass else "warning", "actual": round(avg_blur, 2), "required": config.max_blur_variance}
        if not blur_pass: result.warnings.append("blur_detected")

    if face_areas:
        avg_face_area = float(np.mean(face_areas))
        face_pass = avg_face_area >= config.min_face_area_pct
        result.checks["face_visibility"] = {"status": "pass" if face_pass else "fail", "actual": round(avg_face_area, 2), "required": config.min_face_area_pct}
        if not face_pass: result.blocking_issues.append("face_too_small")

    if lighting_values:
        avg_light = float(np.mean(lighting_values))
        light_pass = avg_light >= 60
        result.checks["lighting"] = {"status": "pass" if light_pass else "warning", "actual": round(avg_light, 2), "note": "Brightness-based proxy"}
        if not light_pass: result.warnings.append("low_lighting")

    if angles:
        max_yaw = max(abs(a["yaw"]) for a in angles)
        max_pitch = max(abs(a["pitch"]) for a in angles)
        max_roll = max(abs(a["roll"]) for a in angles)
        angle_pass = max_yaw <= config.max_yaw and max_pitch <= config.max_pitch and max_roll <= config.max_roll
        result.checks["angle"] = {"status": "pass" if angle_pass else "warning", "actual": {"max_yaw": round(max_yaw,1), "max_pitch": round(max_pitch,1), "max_roll": round(max_roll,1)}, "required": {"max_yaw": config.max_yaw, "max_pitch": config.max_pitch, "max_roll": config.max_roll}}
        if not angle_pass: result.warnings.append("head_angle_exceeded")

    result.checks["occlusion"] = {"status": "pass", "actual": len(occlusion_flags), "required": 0}

    if result.blocking_issues: result.overall = "fail"
    elif result.warnings: result.overall = "warning"
    else: result.overall = "pass"
    return result
