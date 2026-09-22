"""Модуль 4.1.5 — Дрейф данных (Data Drift Detection)."""
from __future__ import annotations
import numpy as np
from dataclasses import dataclass, field, asdict
from typing import Any
from datetime import datetime, timezone, date
from ..config.settings import ModelConfig

@dataclass
class DriftMetric:
    metric_name: str
    psi: float = 0.0
    ks_statistic: float = 0.0
    ks_pvalue: float = 1.0
    mean_current: float = 0.0
    mean_reference: float = 0.0
    std_current: float = 0.0
    std_reference: float = 0.0
    drift_detected: bool = False
    drift_type: str = ""  # "psi" | "ks" | "both" | "none"

@dataclass
class DriftReport:
    report_id: str = ""
    model_version: str = ""
    period_start: str = ""
    period_end: str = ""
    metrics: dict[str, Any] = field(default_factory=dict)
    alerts: dict[str, Any] = field(default_factory=dict)
    n_samples_current: int = 0
    n_samples_reference: int = 0
    overall_drift: bool = False
    drift_severity: str = "none"  # "none" | "low" | "moderate" | "high"
    created_at: str = ""

def _compute_psi(reference: np.ndarray, current: np.ndarray, n_bins: int = 10) -> float:
    """Population Stability Index."""
    if len(reference) < 2 or len(current) < 2:
        return 0.0
    edges = np.linspace(np.min(reference), np.max(reference), n_bins + 1)
    edges[0] = -np.inf
    edges[-1] = np.inf
    ref_hist, _ = np.histogram(reference, bins=edges)
    cur_hist, _ = np.histogram(current, bins=edges)
    ref_pct = ref_hist / len(reference)
    cur_pct = cur_hist / len(current)
    ref_pct = np.clip(ref_pct, 1e-6, None)
    cur_pct = np.clip(cur_pct, 1e-6, None)
    psi = np.sum((cur_pct - ref_pct) * np.log(cur_pct / ref_pct))
    return float(psi)

def _compute_ks(reference: np.ndarray, current: np.ndarray) -> tuple[float, float]:
    """Kolmogorov-Smirnov test."""
    from scipy.stats import ks_2samp
    if len(reference) < 2 or len(current) < 2:
        return 0.0, 1.0
    result = ks_2samp(reference, current)
    return float(result.statistic), float(result.pvalue)

def _severity(psi: float, ks_stat: float, ks_pvalue: float, config: ModelConfig) -> tuple[bool, str]:
    psi_drift = psi > config.drift_psi_threshold
    ks_drift = ks_pvalue < config.drift_ks_pvalue
    if psi_drift and ks_drift:
        if psi > 0.5 or ks_stat > 0.3:
            return True, "high"
        elif psi > 0.35:
            return True, "moderate"
        return True, "low"
    elif psi_drift or ks_drift:
        return True, "low"
    return False, "none"

def detect_drift(reference_data: list[dict[str, float]],
                 current_data: list[dict[str, float]],
                 config: ModelConfig,
                 model_version: str = "",
                 period_start: str = "",
                 period_end: str = "") -> DriftReport:
    import uuid
    report = DriftReport(
        report_id=str(uuid.uuid4()),
        model_version=model_version,
        period_start=period_start,
        period_end=period_end,
        created_at=datetime.now(timezone.utc).isoformat(),
        n_samples_current=len(current_data),
        n_samples_reference=len(reference_data),
    )

    if len(reference_data) < config.drift_min_samples or len(current_data) < config.drift_min_samples:
        report.alerts = {"warning": "insufficient_samples",
                         "min_required": config.drift_min_samples,
                         "reference_count": len(reference_data),
                         "current_count": len(current_data)}
        report.drift_severity = "none"
        return report

    drift_metrics = {}
    drift_detected_count = 0
    severities = []

    for metric_name in config.drift_metrics:
        ref_values = np.array([d[metric_name] for d in reference_data if metric_name in d and d[metric_name] is not None])
        cur_values = np.array([d[metric_name] for d in current_data if metric_name in d and d[metric_name] is not None])

        if len(ref_values) < 2 or len(cur_values) < 2:
            continue

        psi = _compute_psi(ref_values, cur_values)
        ks_stat, ks_pvalue = _compute_ks(ref_values, cur_values)
        detected, severity = _severity(psi, ks_stat, ks_pvalue, config)

        drift_type = "none"
        if psi > config.drift_psi_threshold and ks_pvalue < config.drift_ks_pvalue:
            drift_type = "both"
        elif psi > config.drift_psi_threshold:
            drift_type = "psi"
        elif ks_pvalue < config.drift_ks_pvalue:
            drift_type = "ks"

        dm = DriftMetric(
            metric_name=metric_name, psi=round(psi, 6),
            ks_statistic=round(ks_stat, 6), ks_pvalue=round(ks_pvalue, 6),
            mean_current=round(float(np.mean(cur_values)), 4),
            mean_reference=round(float(np.mean(ref_values)), 4),
            std_current=round(float(np.std(cur_values)), 4),
            std_reference=round(float(np.std(ref_values)), 4),
            drift_detected=detected, drift_type=drift_type,
        )
        drift_metrics[metric_name] = asdict(dm)
        if detected:
            drift_detected_count += 1
            severities.append(severity)

    report.metrics = drift_metrics
    report.overall_drift = drift_detected_count > 0

    if "high" in severities:
        report.drift_severity = "high"
    elif "moderate" in severities:
        report.drift_severity = "moderate"
    elif "low" in severities:
        report.drift_severity = "low"
    else:
        report.drift_severity = "none"

    if report.overall_drift:
        report.alerts = {
            "drift_detected": True,
            "metrics_affected": [k for k, v in drift_metrics.items() if v["drift_detected"]],
            "severity": report.drift_severity,
            "n_metrics_drifted": drift_detected_count,
            "n_metrics_total": len(drift_metrics),
            "recommendation": "investigate_and_retrain" if report.drift_severity in ("high", "moderate") else "monitor",
        }
    else:
        report.alerts = {"drift_detected": False}

    return report

def drift_report_to_dict(report: DriftReport) -> dict:
    return asdict(report)
