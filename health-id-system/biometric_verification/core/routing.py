"""Маршрутизация результатов верификации."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any
from datetime import datetime, timezone
from ..config.settings import ModelConfig

@dataclass
class VerificationResult:
    route: str
    match_score: float
    liveness_score: float
    quality_overall: str
    details: dict[str, Any] = field(default_factory=dict)
    audit: dict[str, Any] = field(default_factory=dict)

def route_verification(match_score: float, liveness_score: float,
                       quality_result: dict[str, Any], session_id: str,
                       config: ModelConfig) -> VerificationResult:
    quality_overall = quality_result.get("overall", "fail")
    if (match_score >= config.match_threshold
            and liveness_score >= config.liveness_pass
            and quality_overall == "pass"):
        route = "verified"
    elif (match_score < config.manual_review_threshold
          or liveness_score < config.liveness_fail
          or quality_overall == "fail"):
        route = "not_verified"
    else:
        route = "manual_review"
    details = {
        "match_category": _cat_match(match_score, config),
        "liveness_category": _cat_liveness(liveness_score, config),
        "quality_category": quality_overall,
        "blocking_quality_issues": quality_result.get("blocking_issues", []),
        "quality_warnings": quality_result.get("warnings", []),
    }
    audit = {
        "session_id": session_id, "model_version": config.model_version,
        "route": route, "match_score": match_score, "liveness_score": liveness_score,
        "quality_overall": quality_overall,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    return VerificationResult(route=route, match_score=match_score,
                             liveness_score=liveness_score,
                             quality_overall=quality_overall, details=details, audit=audit)

def _cat_match(score, config):
    if score >= config.match_threshold: return "high"
    elif score >= config.manual_review_threshold: return "medium"
    return "low"

def _cat_liveness(score, config):
    if score >= config.liveness_pass: return "confirmed"
    elif score >= config.liveness_fail: return "uncertain"
    return "failed"
