"""Модуль 4.1.3 — Расчёт HEALTH_ID."""
from __future__ import annotations
import numpy as np
from dataclasses import dataclass, field, asdict
from typing import Any
from enum import Enum
from .rppg import RPPGOutput
from .baseline import BaselineCorridor
from ..config.settings import ModelConfig, HealthIDCategory

class HealthIDCategoryEnum(str, Enum):
    GOOD = "good"
    WARNING = "warning"
    POOR = "poor"
    INSUFFICIENT_DATA = "insufficient_data"

@dataclass
class HealthIDOutput:
    health_id_value: float = 0.0
    completeness: float = 0.0
    uncertainty_score: float = 0.0
    category: str = "insufficient_data"
    is_acute: bool = False
    is_persistent: bool = False
    is_chronic: bool = False
    z_scores: dict[str, float] = field(default_factory=dict)
    normalized_scores: dict[str, float] = field(default_factory=dict)
    acute_flags: dict[str, bool] = field(default_factory=dict)
    evidence: dict = field(default_factory=dict)
    error: str = ""

def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + np.exp(-x))

def _z_score(value: float, corridor: BaselineCorridor) -> float:
    if corridor.std < 1e-8: return 0.0
    return (value - corridor.mean) / corridor.std

def _normalize(z: float) -> float:
    return float(_sigmoid(-abs(z) * 1.5))

def _check_persistent(history: list[dict], corridors: dict, config: ModelConfig) -> dict[str, bool]:
    result = {}
    for metric, corridor in corridors.items():
        values = [h.get(metric) for h in history[-config.persistent_window:] if h.get(metric) is not None]
        if len(values) >= config.persistent_window:
            outside = sum(1 for v in values if v < corridor.lower or v > corridor.upper)
            result[metric] = outside >= config.persistent_window
        else:
            result[metric] = False
    return result

def _check_chronic(history: list[dict], corridors: dict, config: ModelConfig) -> dict[str, bool]:
    result = {}
    for metric, corridor in corridors.items():
        values = [h.get(metric) for h in history[-config.chronic_window:] if h.get(metric) is not None]
        if len(values) >= 5:
            arr = np.array(values)
            x = np.arange(len(arr))
            slope = float(np.polyfit(x, arr, 1)[0])
            threshold = abs(corridor.mean) * config.chronic_slope_pct
            result[metric] = abs(slope) > threshold
        else:
            result[metric] = False
    return result

def compute_health_id(rppg: RPPGOutput, corridors: dict[str, BaselineCorridor],
                      history: list[dict[str, float]], config: ModelConfig,
                      verification_quality: float = 1.0) -> HealthIDOutput:
    if rppg.error:
        return HealthIDOutput(error=rppg.error, category=HealthIDCategoryEnum.INSUFFICIENT_DATA.value,
                              evidence={"rppg_error": rppg.error})

    raw_metrics = {
        "heart_rate": rppg.heart_rate if rppg.heart_rate > 0 else None,
        "hrv": rppg.hrv_rmssd if rppg.hrv_rmssd > 0 else None,
        "breathing_rate": rppg.breathing_rate if rppg.breathing_rate > 0 else None,
        "stress_index": rppg.stress_index if rppg.stress_index > 0 else None,
        "signal_quality": rppg.signal_quality,
        "verification_quality": verification_quality,
    }

    available = {k: v for k, v in raw_metrics.items() if v is not None}
    completeness = len(available) / len(raw_metrics)

    if completeness < 0.5:
        return HealthIDOutput(completeness=completeness,
                              category=HealthIDCategoryEnum.INSUFFICIENT_DATA.value,
                              evidence={"available": list(available.keys()), "missing": [k for k in raw_metrics if k not in available]})

    z_scores = {}
    normalized = {}
    acute_flags = {}
    for metric in ["heart_rate", "hrv", "breathing_rate", "stress_index"]:
        if metric in available and metric in corridors:
            z = _z_score(available[metric], corridors[metric])
            z_scores[metric] = round(z, 4)
            normalized[metric] = round(_normalize(z), 4)
            acute_flags[metric] = abs(z) > config.acute_z_threshold
    normalized["signal_quality"] = available.get("signal_quality", 0)
    normalized["verification_quality"] = available.get("verification_quality", 1.0)

    weights = config.health_id_weights
    total_weight = sum(weights.get(k, 0) for k in normalized)
    health_id_value = sum(normalized[k] * weights.get(k, 0) for k in normalized) / total_weight if total_weight > 0 else 0

    is_acute = any(acute_flags.values())
    persistent_flags = _check_persistent(history, corridors, config)
    is_persistent = any(persistent_flags.values())
    chronic_flags = _check_chronic(history, corridors, config)
    is_chronic = any(chronic_flags.values())

    # Uncertainty
    uncertainty = (1 - completeness) * 0.35 + (1 - rppg.signal_quality) * 0.25
    if any(c.fallback for c in corridors.values()): uncertainty += 0.15
    if verification_quality < 0.7: uncertainty += 0.10
    if rppg.error: uncertainty += 0.10
    uncertainty = float(np.clip(uncertainty, 0, 1))

    if health_id_value >= config.health_id_good:
        category = HealthIDCategoryEnum.GOOD.value
    elif health_id_value >= config.health_id_warning:
        category = HealthIDCategoryEnum.WARNING.value
    else:
        category = HealthIDCategoryEnum.POOR.value

    return HealthIDOutput(
        health_id_value=round(health_id_value, 4),
        completeness=round(completeness, 4),
        uncertainty_score=round(uncertainty, 4),
        category=category, is_acute=is_acute,
        is_persistent=is_persistent, is_chronic=is_chronic,
        z_scores=z_scores, normalized_scores=normalized,
        acute_flags=acute_flags,
        evidence={
            "raw_metrics": {k: v for k, v in available.items()},
            "corridors": {k: {"mean": c.mean, "lower": c.lower, "upper": c.upper} for k, c in corridors.items()},
            "persistent_flags": persistent_flags,
            "chronic_flags": chronic_flags,
            "rppg": {"heart_rate": rppg.heart_rate, "hrv": rppg.hrv_rmssd,
                      "breathing_rate": rppg.breathing_rate, "stress_index": rppg.stress_index,
                      "signal_quality": rppg.signal_quality},
        },
    )
