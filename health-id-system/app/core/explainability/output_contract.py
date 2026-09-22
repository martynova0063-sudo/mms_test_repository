"""
app/core/explainability/output_contract.py

Модуль 6: Формирование выходного контракта.

Собирает данные из всех модулей в единую структуру,
готовую для API-ответа и для медработника.
"""

from app.db.models import HealthIdResult
from app.core.classification.rules import ClassificationResult
from app.core.data.baseline import Baseline
from app.core.engine.health_id_engine import ComponentResult


def build_output_contract(
    result: HealthIdResult,
    components: list[ComponentResult],
    classification: ClassificationResult,
    baseline: Baseline,
) -> dict:
    """
    Формирует полный выходной контракт (раздел 9.1).

    Args:
        result:          запись HealthIdResult из БД
        components:      результаты расчёта компонентов
        classification:  результат классификации состояния
        baseline:        рассчитанный baseline (для evidence)

    Returns:
        dict в формате CalculateResponse
    """
    # --- Компоненты ---
    comp_names_ru = {
        "hBody": "Физическое состояние",
        "hMental": "Психическое состояние",
        "hSocial": "Социальный контекст",
    }

    components_out = {}
    for comp in components:
        features_out = []
        for feat in comp.features:
            features_out.append({
                "name": feat.name,
                "raw_value": feat.raw_value,
                "unit": feat.unit,
                "normalized_score": feat.normalized_score,
                "normal_range": list(feat.normal_range) if feat.normal_range else None,
                "contribution_weight": feat.contribution_weight,
                "contribution": feat.contribution,
                "available": feat.available,
                "quality": feat.quality if feat.available else None,
            })

        components_out[comp.name] = {
            "name": comp.name,
            "label_ru": comp_names_ru.get(comp.name, comp.name),
            "value": round(comp.score, 4),
            "weight": comp.weight,
            "contribution": round(comp.contribution, 4),
            "available_features": comp.available_count,
            "total_features": comp.total_count,
            "features": features_out,
        }

    # --- State flags ---
    state_flags_out = []
    for flag in classification.flags:
        state_flags_out.append(flag.to_dict())

    # --- Evidence ---
    evidence_out = {
        "input_ids": [result.event.event_id] if result.event else [],
        "quality_reports": result.event.quality_report if result.event else None,
        "formulas_applied": (result.evidence or {}).get("formulas_applied", []),
        "contribution_trace": (result.evidence or {}).get("contribution_trace", {}),
        "model_card_ref": result.model_version,
        "config_hash": result.config_snapshot_hash,
        "state_flags": state_flags_out,
        "classification_summary": classification.summary,
        "baseline": baseline.to_dict() if baseline else None,
    }

    # --- Сборка контракта ---
    contract = {
        "result_id": result.id,
        "event_id": result.event.event_id if result.event else None,
        "health_id": {
            "value": result.value,
            "category": result.category,
        },
        "components": components_out,
        "completeness": result.completeness,
        "uncertainty": result.uncertainty,
        "missing_features": result.missing_features,
        "state_flags": state_flags_out,
        "dominant_flag": classification.dominant_flag,
        "evidence": evidence_out,
        "human_readable": result.human_readable,
        "disclaimer": result.disclaimer,
        "model_version": result.model_version,
        "config_snapshot_hash": result.config_snapshot_hash,
        "quality_status": result.event.quality_status if result.event else "unknown",
        "calculation_duration_ms": result.calculation_duration_ms,
        "reproducible": result.reproducible,
    }

    return contract
