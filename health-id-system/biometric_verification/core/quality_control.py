"""Контроль качества видеопотока."""
from __future__ import annotations
import cv2, numpy as np
from dataclasses import dataclass, field
from typing import Any, List
from .face_matching import FrameFaceContext
from ..config.settings import ModelConfig


@dataclass
class QualityResult:
    overall: str
    checks: dict[str, dict[str, Any]] = field(default_factory=dict)
    blocking_issues: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def check_video_quality(
    contexts: List[FrameFaceContext],
    config: ModelConfig,
    width: int,
    height: int,
    fps: float,
    duration_sec: float,
) -> QualityResult:
    """
    Принимает контексты кадров из face_matching.
    Метаданные (width, height, fps, duration_sec) передаются извне.
    Не открывает видео и не детектит лица заново.
    """
    result = QualityResult(overall="pass")

    # --- Базовые проверки по метаданным ---
    min_w, min_h = config.min_resolution
    res_pass = width >= min_w and height >= min_h
    result.checks["resolution"] = {
        "status": "pass" if res_pass else "fail",
        "actual": [width, height],
        "required": [min_w, min_h],
    }
    if not res_pass:
        result.blocking_issues.append("resolution_too_low")

    fps_pass = fps >= config.min_fps
    result.checks["fps"] = {
        "status": "pass" if fps_pass else "warning",
        "actual": round(fps, 1),
        "required": config.min_fps,
    }
    if not fps_pass:
        result.warnings.append("low_fps")

    dur_pass = duration_sec >= config.min_duration_sec
    result.checks["duration"] = {
        "status": "pass" if dur_pass else "fail",
        "actual": round(duration_sec, 2),
        "required": config.min_duration_sec,
    }
    if not dur_pass:
        result.blocking_issues.append("duration_too_short")

    # --- Валидные кадры с лицом ---
    valid = [c for c in contexts if c.is_valid and c.face_box is not None]
    if len(valid) == 0:
        # Нет кадров с лицом — это блокирующая проблема
        result.overall = "fail"
        result.blocking_issues.append("no_face_detected")
        result.checks["face_visibility"] = {"status": "fail", "actual": 0, "required": config.min_face_area_pct}
        return result

    blur_values: list[float] = []
    face_areas: list[float] = []
    lighting_values: list[float] = []
    angles: list[dict] = []

    for ctx in valid:
        frame = ctx.frame
        box = ctx.face_box
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        # Blur (Laplacian variance)
        blur_var = cv2.Laplacian(gray, cv2.CV_64F).var()
        blur_values.append(float(blur_var))

        # Lighting (mean brightness)
        brightness = float(np.mean(gray))
        lighting_values.append(brightness)

        # Face area (pct of frame)
        face_area = (box.w * box.h) / (width * height) * 100
        face_areas.append(face_area)

        # Angles (если есть в face_box)
        if hasattr(box, "yaw") and hasattr(box, "pitch") and hasattr(box, "roll"):
            angles.append({
                "yaw": getattr(box, "yaw"),
                "pitch": getattr(box, "pitch"),
                "roll": getattr(box, "roll"),
            })

    # --- Blur ---
    if blur_values:
        avg_blur = float(np.mean(blur_values))
        # В конфиге max_blur_variance — чем выше, тем лучше (меньше размытие).
        blur_pass = avg_blur >= config.max_blur_variance
        result.checks["blur"] = {
            "status": "pass" if blur_pass else "warning",
            "actual": round(avg_blur, 2),
            "required": config.max_blur_variance,
        }
        if not blur_pass:
            result.warnings.append("blur_detected")

    # --- Face visibility (area) ---
    avg_face_area = float(np.mean(face_areas))
    face_pass = avg_face_area >= config.min_face_area_pct
    result.checks["face_visibility"] = {
        "status": "pass" if face_pass else "fail",
        "actual": round(avg_face_area, 2),
        "required": config.min_face_area_pct,
    }
    if not face_pass:
        result.blocking_issues.append("face_too_small")

     # --- Multi-face detection ---
    # Считаем кадры, где было >1 лицо (это должно быть известно из контекста)
    multi_face_frames = sum(1 for c in contexts if c.is_valid and len(c.faces) > 1)
    total_processed = len(contexts)  # или len(valid) — зависит от того, что ты хочешь считать базой
    multi_face_ratio = multi_face_frames / total_processed if total_processed > 0 else 0.0

    warn_threshold = config.multi_face_warn_threshold
    block_threshold = config.multi_face_block_threshold

    if multi_face_ratio >= block_threshold:
        multi_face_status = "fail"
        result.blocking_issues.append("multi_face_detected")
    elif multi_face_ratio >= warn_threshold:
        multi_face_status = "warning"
        result.warnings.append("multi_face_warning")
    else:
        multi_face_status = "pass"

    result.checks["multi_face"] = {
        "status": multi_face_status,
        "actual": round(multi_face_ratio, 3),
        "warn_threshold": warn_threshold,
        "block_threshold": block_threshold,
        "multi_face_frames": multi_face_frames,
        "total_frames": total_processed,
    }    

    # --- Lighting ---
    if lighting_values:
        avg_light = float(np.mean(lighting_values))
        light_pass = avg_light >= 60
        result.checks["lighting"] = {
            "status": "pass" if light_pass else "warning",
            "actual": round(avg_light, 2),
            "note": "Brightness-based proxy",
        }
        if not light_pass:
            result.warnings.append("low_lighting")

    # --- Head angles ---
    if angles:
        max_yaw = max(abs(a["yaw"]) for a in angles)
        max_pitch = max(abs(a["pitch"]) for a in angles)
        max_roll = max(abs(a["roll"]) for a in angles)

        angle_pass = (
            max_yaw <= config.max_yaw
            and max_pitch <= config.max_pitch
            and max_roll <= config.max_roll
        )
        result.checks["angle"] = {
            "status": "pass" if angle_pass else "warning",
            "actual": {
                "max_yaw": round(max_yaw, 1),
                "max_pitch": round(max_pitch, 1),
                "max_roll": round(max_roll, 1),
            },
            "required": {
                "max_yaw": config.max_yaw,
                "max_pitch": config.max_pitch,
                "max_roll": config.max_roll,
            },
        }
        if not angle_pass:
            result.warnings.append("head_angle_exceeded")
    else:
        # Если углы не пришли в face_box — считаем это предупреждением
        result.checks["angle"] = {"status": "warning", "actual": None, "note": "no_angles_available"}
        result.warnings.append("angles_unavailable")

    # --- Occlusion (простая эвристика: если в face_box есть флаг occlusion) ---
    occlusion_flags = [1 for c in valid if hasattr(c.face_box, "occluded") and getattr(c.face_box, "occluded")]
    n_occluded = len(occlusion_flags)
    occlusion_pass = n_occluded == 0
    result.checks["occlusion"] = {
        "status": "pass" if occlusion_pass else "warning",
        "actual": n_occluded,
        "required": 0,
    }
    if not occlusion_pass:
        result.warnings.append("occlusion_detected")

    # --- Итоговый вердикт ---
    if result.blocking_issues:
        result.overall = "fail"
    elif result.warnings:
        result.overall = "warning"
    else:
        result.overall = "pass"

    return result
