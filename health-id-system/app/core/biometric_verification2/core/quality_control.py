"""
Контроль качества видеопотока для биометрической верификации.
Все результаты сохраняются в аудит. Исходные видео не хранятся.
"""
from __future__ import annotations

import cv2
import numpy as np
from dataclasses import dataclass, field
from typing import Any

from biometric_verification.core.face_detector import DetectedFace
from biometric_verification.config.settings import ModelConfig


@dataclass
class QualityResult:
    overall: str  # "pass" | "warning" | "fail"
    checks: dict[str, dict[str, Any]] = field(default_factory=dict)
    blocking_issues: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "overall": self.overall,
            "checks": self.checks,
            "blocking_issues": self.blocking_issues,
            "warnings": self.warnings,
        }


def _build_quality_checks(config: ModelConfig) -> dict[str, dict[str, Any]]:
    return {
        "resolution": {"min": config.quality_min_resolution, "actual": None},
        "fps": {"min": config.quality_min_fps, "actual": None},
        "lighting": {"min": config.quality_min_lighting, "actual": None},
        "face_visibility": {"min_area_pct": config.quality_min_face_area_pct, "actual": None},
        "blur": {"max_variance": config.quality_max_blur, "actual": None},
        "occlusion": {"max_pct": config.quality_max_occlusion_pct, "actual": None},
        "angle": {
            "max_yaw": config.quality_max_yaw,
            "max_pitch": config.quality_max_pitch,
            "max_roll": config.quality_max_roll,
            "actual": None,
        },
        "duration": {"min_sec": config.quality_min_duration_sec, "actual": None},
    }


def check_video_quality(
    video_path: str,
    face_detector: Any = None,
    config: ModelConfig | None = None,
) -> QualityResult:
    """Полная проверка качества видеопотока."""
    config = config or ModelConfig()
    quality_checks = _build_quality_checks(config)
    result = QualityResult(overall="pass")

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        result.overall = "fail"
        result.blocking_issues.append("cannot_open_video")
        return result

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration_sec = frame_count / fps if fps > 0 else 0

    # 1. Разрешение
    min_w, min_h = quality_checks["resolution"]["min"]
    res_pass = width >= min_w and height >= min_h
    result.checks["resolution"] = {
        "status": "pass" if res_pass else "fail",
        "actual": (width, height),
        "required": (min_w, min_h),
    }
    if not res_pass:
        result.blocking_issues.append("resolution_too_low")

    # 2. FPS
    fps_pass = fps >= quality_checks["fps"]["min"]
    result.checks["fps"] = {
        "status": "pass" if fps_pass else "warning",
        "actual": round(fps, 1),
        "required": quality_checks["fps"]["min"],
    }
    if not fps_pass:
        result.warnings.append("low_fps")

    # 3. Длительность
    dur_pass = duration_sec >= quality_checks["duration"]["min_sec"]
    result.checks["duration"] = {
        "status": "pass" if dur_pass else "fail",
        "actual": round(duration_sec, 2),
        "required": quality_checks["duration"]["min_sec"],
    }
    if not dur_pass:
        result.blocking_issues.append("duration_too_short")

    sample_interval = max(1, frame_count // 30)
    blur_values: list[float] = []
    face_areas: list[float] = []
    lighting_values: list[float] = []
    angles: list[dict[str, float]] = []
    occlusion_flags: list[int] = []

    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % sample_interval == 0:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

            blur_var = cv2.Laplacian(gray, cv2.CV_64F).var()
            blur_values.append(float(blur_var))

            brightness = float(np.mean(gray))
            lighting_values.append(brightness)

            if face_detector is not None:
                faces = face_detector.detect(frame)
                if faces:
                    face = max(faces, key=lambda f: f.area)
                    face_area = (face.w * face.h) / (width * height) * 100
                    face_areas.append(face_area)

                    angles.append({
                        "yaw": face.yaw,
                        "pitch": face.pitch,
                        "roll": face.roll,
                    })

                    if face.occlusion_pct > quality_checks["occlusion"]["max_pct"]:
                        occlusion_flags.append(frame_idx)
                else:
                    face_areas.append(0.0)

        frame_idx += 1

    cap.release()

    if blur_values:
        avg_blur = float(np.mean(blur_values))
        blur_pass = avg_blur >= quality_checks["blur"]["max_variance"]
        result.checks["blur"] = {
            "status": "pass" if blur_pass else "warning",
            "actual": round(avg_blur, 2),
            "required": quality_checks["blur"]["max_variance"],
        }
        if not blur_pass:
            result.warnings.append("blur_detected")

    if face_areas:
        avg_face_area = float(np.mean(face_areas))
        face_pass = avg_face_area >= quality_checks["face_visibility"]["min_area_pct"]
        result.checks["face_visibility"] = {
            "status": "pass" if face_pass else "fail",
            "actual": round(avg_face_area, 2),
            "required": quality_checks["face_visibility"]["min_area_pct"],
        }
        if not face_pass:
            result.blocking_issues.append("face_too_small")

    if lighting_values:
        avg_light = float(np.mean(lighting_values))
        light_pass = avg_light >= quality_checks["lighting"]["min"]
        result.checks["lighting"] = {
            "status": "pass" if light_pass else "warning",
            "actual": round(avg_light, 2),
            "note": "Brightness-based proxy, not true lux measurement",
        }
        if not light_pass:
            result.warnings.append("low_lighting")

    if angles:
        max_yaw = max(abs(a["yaw"]) for a in angles)
        max_pitch = max(abs(a["pitch"]) for a in angles)
        max_roll = max(abs(a["roll"]) for a in angles)

        angle_pass = (max_yaw <= quality_checks["angle"]["max_yaw"] and
                      max_pitch <= quality_checks["angle"]["max_pitch"] and
                      max_roll <= quality_checks["angle"]["max_roll"])
        result.checks["angle"] = {
            "status": "pass" if angle_pass else "warning",
            "actual": {
                "max_yaw": round(max_yaw, 1),
                "max_pitch": round(max_pitch, 1),
                "max_roll": round(max_roll, 1),
            },
            "required": {
                "max_yaw": quality_checks["angle"]["max_yaw"],
                "max_pitch": quality_checks["angle"]["max_pitch"],
                "max_roll": quality_checks["angle"]["max_roll"],
            },
        }
        if not angle_pass:
            result.warnings.append("head_angle_exceeded")

    occlusion_pass = len(occlusion_flags) == 0
    result.checks["occlusion"] = {
        "status": "pass" if occlusion_pass else "warning",
        "actual": len(occlusion_flags),
        "required": 0,
    }
    if not occlusion_pass:
        result.warnings.append("occlusion_detected")

    if result.blocking_issues:
        result.overall = "fail"
    elif result.warnings:
        result.overall = "warning"
    else:
        result.overall = "pass"

    return result
