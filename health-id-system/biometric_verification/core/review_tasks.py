"""Модуль 4.1.4 — Review Tasks на основе отклонений HEALTH_ID."""
from __future__ import annotations
import uuid, json
from dataclasses import dataclass, field, asdict
from typing import Any
from datetime import datetime, timezone
from ..config.settings import ModelConfig
from .health_id import HealthIDOutput

@dataclass
class ReviewTask:
    review_id: str
    calculation_id: str
    status: str = "pending"
    priority: str = "routine"
    trigger: str = ""
    trigger_details: dict = field(default_factory=dict)
    health_id_value: float = 0.0
    category: str = ""
    is_acute: bool = False
    is_persistent: bool = False
    is_chronic: bool = False
    match_score: float = 0.0
    liveness_score: float = 0.0
    verification_route: str = ""
    audit_trail: list = field(default_factory=list)

def _now_iso():
    return datetime.now(timezone.utc).isoformat()

def generate_review_tasks(calculation_id: str, health_id: HealthIDOutput,
                          match_score: float, liveness_score: float,
                          verification_route: str, config: ModelConfig) -> list[ReviewTask]:
    tasks = []
    base_audit = {"timestamp": _now_iso(), "action": "task_created"}

    if config.review_trigger_acute and health_id.is_acute:
        tasks.append(ReviewTask(
            review_id=str(uuid.uuid4()), calculation_id=calculation_id,
            status="pending", priority="urgent", trigger="acute_deviation",
            trigger_details={"z_scores": health_id.z_scores, "acute_flags": health_id.acute_flags},
            health_id_value=health_id.health_id_value, category=health_id.category,
            is_acute=True, match_score=match_score, liveness_score=liveness_score,
            verification_route=verification_route, audit_trail=[base_audit],
        ))

    if config.review_trigger_poor and health_id.category == "poor":
        tasks.append(ReviewTask(
            review_id=str(uuid.uuid4()), calculation_id=calculation_id,
            status="pending", priority="routine", trigger="poor_health_id",
            trigger_details={"health_id_value": health_id.health_id_value, "category": health_id.category},
            health_id_value=health_id.health_id_value, category=health_id.category,
            match_score=match_score, liveness_score=liveness_score,
            verification_route=verification_route, audit_trail=[base_audit],
        ))

    if config.review_trigger_persistent and health_id.is_persistent:
        tasks.append(ReviewTask(
            review_id=str(uuid.uuid4()), calculation_id=calculation_id,
            status="pending", priority="routine", trigger="persistent_deviation",
            trigger_details={"persistent_flags": health_id.evidence.get("persistent_flags", {})},
            health_id_value=health_id.health_id_value, category=health_id.category,
            is_persistent=True, match_score=match_score, liveness_score=liveness_score,
            verification_route=verification_route, audit_trail=[base_audit],
        ))

    if config.review_trigger_chronic and health_id.is_chronic:
        tasks.append(ReviewTask(
            review_id=str(uuid.uuid4()), calculation_id=calculation_id,
            status="pending", priority="routine", trigger="chronic_trend",
            trigger_details={"chronic_flags": health_id.evidence.get("chronic_flags", {})},
            health_id_value=health_id.health_id_value, category=health_id.category,
            is_chronic=True, match_score=match_score, liveness_score=liveness_score,
            verification_route=verification_route, audit_trail=[base_audit],
        ))

    if config.review_trigger_manual and verification_route == "manual_review":
        tasks.append(ReviewTask(
            review_id=str(uuid.uuid4()), calculation_id=calculation_id,
            status="pending", priority="routine", trigger="manual_verification",
            trigger_details={"route": verification_route},
            health_id_value=health_id.health_id_value, category=health_id.category,
            match_score=match_score, liveness_score=liveness_score,
            verification_route=verification_route, audit_trail=[base_audit],
        ))

    return tasks

def review_task_to_dict(task: ReviewTask) -> dict:
    return asdict(task)

def update_review_status(task: ReviewTask, status: str, reviewer_id: str,
                         reviewer_qualification: str, comment: str = "",
                         decision_rationale: str = "") -> ReviewTask:
    task.status = status
    task.audit_trail.append({
        "timestamp": _now_iso(), "action": f"status_{status}",
        "reviewer_id": reviewer_id, "reviewer_qualification": reviewer_qualification,
        "comment": comment, "decision_rationale": decision_rationale,
    })
    return task
