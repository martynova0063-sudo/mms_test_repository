"""
Маршрутизация результатов биометрической верификации.
Определяет: verified / manual_review / not_verified.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from biometric_verification.config.settings import ModelConfig


@dataclass
class VerificationResult:
    route: str  # "verified" | "manual_review" | "not_verified"
    match_score: float
    liveness_score: float
    quality_overall: str
    details: dict[str, Any]
    audit: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "route": self.route,
            "match_score": self.match_score,
            "liveness_score": self.liveness_score,
            "quality_overall": self.quality_overall,
            "details": self.details,
            "audit": self.audit,
        }


def route_verification(
    match_score: float,
    liveness_score: float,
    quality_result: dict[str, Any],
    session_id: str,
    config: ModelConfig | None = None,
) -> VerificationResult:
    """Определяет маршрут результата верификации."""
    config = config or ModelConfig()
    quality_overall = quality_result.get("overall", "fail")

    liveness_pass = 0.70
    liveness_warning = 0.50

    if (match_score >= config.match_threshold
            and liveness_score >= liveness_pass
            and quality_overall == "pass"):
        route = "verified"
    elif (match_score < config.manual_review_threshold
          or liveness_score < liveness_warning
          or quality_overall == "fail"):
        route = "not_verified"
    else:
        route = "manual_review"

    details = {
        "match_category": _categorize_match(match_score, config),
        "liveness_category": _categorize_liveness(liveness_score),
        "quality_category": quality_overall,
        "thresholds_used": {
            "match_threshold": config.match_threshold,
            "manual_review_threshold": config.manual_review_threshold,
            "liveness_pass": liveness_pass,
            "liveness_warning": liveness_warning,
        },
        "blocking_quality_issues": quality_result.get("blocking_issues", []),
        "quality_warnings": quality_result.get("warnings", []),
    }

    audit = {
        "session_id": session_id,
        "model_version": config.model_version,
        "config_hash": config.config_hash,
        "route": route,
        "match_score": round(match_score, 6),
        "liveness_score": round(liveness_score, 6),
        "quality_overall": quality_overall,
        "timestamp": _now_iso(),
    }

    return VerificationResult(
        route=route,
        match_score=match_score,
        liveness_score=liveness_score,
        quality_overall=quality_overall,
        details=details,
        audit=audit,
    )


def _categorize_match(score: float, config: ModelConfig) -> str:
    if score >= config.match_threshold:
        return "high"
    elif score >= config.manual_review_threshold:
        return "medium"
    return "low"


def _categorize_liveness(score: float) -> str:
    if score >= 0.70:
        return "confirmed"
    elif score >= 0.50:
        return "uncertain"
    return "failed"


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
