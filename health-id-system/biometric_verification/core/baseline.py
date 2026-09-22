"""Baseline коридоры работника."""
from __future__ import annotations
import numpy as np
from dataclasses import dataclass, field
from typing import Any
from ..config.settings import ModelConfig

@dataclass
class BaselineCorridor:
    mean: float
    std: float
    lower: float
    upper: float
    n_points: int
    fallback: bool = False
    fallback_reason: str = ""

def build_baseline(history: list[dict[str, float]], config: ModelConfig,
                   metric: str) -> BaselineCorridor:
    values = [h[metric] for h in history if metric in h and h[metric] is not None]
    if len(values) >= config.min_history_for_corridor:
        arr = np.array(values)
        mean = float(np.mean(arr))
        std = float(np.std(arr)) or 1.0
        return BaselineCorridor(mean=mean, std=std, lower=mean - 2*std, upper=mean + 2*std,
                                n_points=len(values))
    pop = config.pop_baseline.get(metric)
    if pop:
        return BaselineCorridor(mean=pop["mean"], std=pop["std"],
                                lower=pop["mean"] - 2*pop["std"], upper=pop["mean"] + 2*pop["std"],
                                n_points=len(values), fallback=True, fallback_reason="insufficient_history")
    return BaselineCorridor(mean=0, std=1, lower=-2, upper=2, n_points=len(values),
                            fallback=True, fallback_reason="no_population_data")

def build_all_baselines(history: list[dict[str, float]], config: ModelConfig) -> dict[str, BaselineCorridor]:
    metrics = ["heart_rate", "hrv", "breathing_rate", "stress_index"]
    return {m: build_baseline(history, config, m) for m in metrics}

def corridors_to_dict(corridors: dict[str, BaselineCorridor]) -> dict:
    return {k: {"mean": v.mean, "std": v.std, "lower": v.lower, "upper": v.upper,
                "n_points": v.n_points, "fallback": v.fallback, "fallback_reason": v.fallback_reason}
            for k, v in corridors.items()}
