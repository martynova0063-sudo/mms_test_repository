---
name: health_id_replit_agent
description: Навыки для разработки исследовательской системы биометрической верификации и расчёта HEALTH_ID в Replit. Агент должен соблюдать регуляторные требования, принципы прослеживаемости, версионирования моделей и разделения контуров.
tags:
  - biometrics
  - health-index
  - research-mode
  - regulatory-compliance
  - replit
---

# Навыки (Skills) для агента в проекте HEALTH_ID (Replit)

## 1. Общие принципы и ограничения

- **Режим «только исследовательский»**: агент обязан во всех выходных контрактах, комментариях к коду и документации явно указывать, что система не является медицинским изделием и не предназначена для клинических решений до завершения валидации R0–R4.
- **Разделение медицинского и корпоративного контуров**: агент должен проектировать API и БД так, чтобы медицинские данные (показатели, HEALTH_ID, выводы) не попадали в корпоративный контур; передаётся только статус верификации (`verified/manual_review/not_verified`) и ID сессии.
- **Прослеживаемость и воспроизводимость**: любой расчёт должен сопровождаться фиксацией версии модели, хеша конфигурации и входных данных; агент обязан добавлять в код логику сохранения этих артефактов в аудит.
- **Регуляторные требования**: агент должен учитывать 323‑ФЗ, 152‑ФЗ, ПП РФ №866 и другие акты из ТЗ; в коде и комментариях избегать формулировок, которые могут трактоваться как юридически значимая идентификация личности.

## 2. Работа с биометрией и верификацией

- **Face Matching**: при реализации использовать подход на основе face embeddings и косинусного расстояния; порог по умолчанию — `cosine_similarity ≥ 0.62`, с возможностью конфигурации.
- **Liveness Detection**: агент должен реализовывать комбинированный подход (активный + пассивный liveness) и фиксировать тип обнаруженной атаки, если применимо.
- **Контроль качества видео**: агент обязан внедрить набор проверок (разрешение, FPS, освещённость, видимость лица, размытие, окклюзии, углы, длительность) и сохранять результаты в аудит; не хранить исходные видео и эталонные фото, только хеши и метаданные.
- **Маршрутизация результатов**: агент должен реализовать логику маршрутизации в зависимости от `match_score` и статуса liveness/качества (авто‑пропуск, human review, отказ) и явно документировать пороги в коде.

## 3. Движок расчёта HEALTH_ID

- **Версионирование модели**: агент обязан хранить конфигурацию модели в неизменяемом виде (например, YAML/JSON) с версией и хешем; при расчёте фиксировать `model_version` и `config_snapshot_hash`.
- **Формула и веса**: использовать формулу `HEALTH_ID = hBody × 0.60 + hMental × 0.25 + hSocial × 0.15` и строго следовать описанию компонентов и весов из ТЗ.
- **Источники данных**: агент должен явно помечать каждый признак как `measured` (измерено), `derived` (вычислено) или `context` (контекст) и не смешивать их в логике расчёта.
- **Неполные данные**: агент должен поддерживать частичный расчёт при недостатке данных, но обязательно отмечать уровень полноты (`completeness`) и неопределённость (`uncertainty`).
- **Дисклеймер**: агент обязан включать явный дисклеймер в выходной контракт: «Исследовательский результат. Не является медицинским диагнозом».

## 4. Приём и контроль качества входных данных

- **Валидация и чек‑лист**: агент должен реализовать набор проверок (происхождение, целостность, единицы измерения, качество сигнала, процент артефактов, полнота, протокол, временные рамки, дубликаты) и возвращать структурированный отчёт о качестве.
- **Обработка ошибок**: пакеты с `fail` не должны попадать в расчёт, но фиксируются в аудите; пакеты с `warning` допускаются к расчёту с пометкой неполноты.

## 5. Персональные коридоры (baseline) и классификация

- **Исключение текущей точки**: агент обязан исключать текущее измерение из расчёта персонального коридора (baseline) для предотвращения утечки данных.
- **Статистика**: агент должен рассчитывать среднее, стандартное отклонение, медиану, процентили и границы коридора; фиксировать количество точек и окно наблюдения.
- **Классификация состояния**: агент должен применять правила классификации (острое отклонение, устойчивое повторное отклонение, хроническое) и не использовать HEALTH_ID как единственный источник для выводов о состоянии.

## 6. Реализация в Replit и технологический стек

- **Стек**: Python (FastAPI), PostgreSQL (для аудита и метаданных), Replit Database (если используется), Drizzle ORM или аналогичная ORM/query builder, библиотеки для работы с изображениями и embeddings.
- **Структура проекта**: агент должен придерживаться модульной структуры (биометрия, движок HEALTH_ID, приём данных, baseline, классификация, API, аудит) и размещать код в соответствующих папках.
- **Тестирование**: агент должен добавлять unit‑тесты для ключевых функций (расчёт HEALTH_ID, валидация входных данных, логика маршрутизации) и интеграционные тесты с моками внешних зависимостей.
- **Безопасность**: агент не должен хранить чувствительные данные в коде или переменных окружения; использовать секреты через Replit Secrets; избегать хардкода ключей и паролей.

## 7. Примеры триггеров для активации навыков

Агент должен применять эти навыки, когда в задаче встречаются формулировки:

- «реализуй расчёт HEALTH_ID»
- «добавь биометрическую верификацию»
- «настрой маршрутизацию результатов верификации»
- «внедри контроль качества данных»
- «сделай воспроизводимый расчёт с прослеживаемостью»
- «соблюди регуляторные требования для дистанционных медосмотров»

## 8. Примеры шаблонов и фрагментов кода

### Шаблон функции расчёта HEALTH_ID

```python
def calculate_health_id(input_data: HealthInput, model_version: str) -> HealthResult:
    # 1. Загрузка неизменяемой конфигурации версии
    config = load_model_config(model_version)
    
    # 2. Валидация входных данных
    validated = validate_input(input_data, config)
    
    # 3. Расчёт компонентов
    hBody = calculate_component(validated, config.components.hBody)
    hMental = calculate_component(validated, config.components.hMental)
    hSocial = calculate_component(validated, config.components.hSocial)
    
    # 4. Расчёт итогового индекса
    health_id = (
        hBody.score * config.components.hBody.weight +
        hMental.score * config.components.hMental.weight +
        hSocial.score * config.components.hSocial.weight
    )
    
    # 5. Оценка неопределённости и полноты
    uncertainty = estimate_uncertainty(validated, hBody, hMental, hSocial)
    completeness = calculate_completeness(validated)
    
    # 6. Формирование выходного контракта
    result = HealthResult(
        value=health_id,
        model_version=model_version,
        config_snapshot_hash=hash_config(config),
        components={
            "hBody": {"value": hBody.score, "weight": 0.60, "contribution": hBody.score * 0.60},
            "hMental": {"value": hMental.score, "weight": 0.25, "contribution": hMental.score * 0.25},
            "hSocial": {"value": hSocial.score, "weight": 0.15, "contribution": hSocial.score * 0.15},
        },
        completeness=completeness,
        uncertainty=uncertainty,
        disclaimer="Исследовательский результат. Не является медицинским диагнозом.",
    )
    return result
```


# Примеры шаблонов и фрагментов кода
## Шаблон функции расчёта HEALTH_ID
```python
"""
Движок расчёта интегрального индекса здоровья HEALTH_ID.
Исследовательская версия. Не является медицинским изделием.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

import numpy as np
from pydantic import BaseModel, Field

# ─── Схемы данных ────────────────────────────────────────────────

class FeatureInput(BaseModel):
    """Один измеренный признак."""
    name: str
    value: float | None
    unit: str
    source: Literal["measured", "derived", "context"]
    device_id: str | None = None
    device_model: str | None = None
    measurement_protocol: str | None = None
    confidence: float = 1.0
    artifact_pct: float = 0.0
    timestamp: str


class HealthInput(BaseModel):
    """Входной пакет данных для расчёта HEALTH_ID."""
    event_id: str
    worker_pseudonym: str
    timestamp: str
    measurements: list[FeatureInput]
    context: dict[str, Any] = Field(default_factory=dict)


class ComponentResult(BaseModel):
    """Результат расчёта одного компонента (hBody, hMental, hSocial)."""
    name: str
    score: float
    weight: float
    contribution: float
    contribution_pct: float
    features: list[dict[str, Any]]


class EvidenceTrace(BaseModel):
    """Полный trace расчёта для прослеживаемости."""
    input_ids: list[str]
    quality_reports: list[dict[str, Any]]
    formulas_applied: list[str]
    norms_used: dict[str, Any]
    contribution_trace: dict[str, Any]
    baseline_used: dict[str, Any] | None
    model_card_ref: str


class HealthResult(BaseModel):
    """Выходной контракт — результат расчёта HEALTH_ID."""
    result_id: str
    event_id: str
    worker_pseudonym: str
    timestamp: str

    health_id: dict[str, Any]
    components: dict[str, ComponentResult]
    completeness: dict[str, Any]
    uncertainty: dict[str, Any]
    state_flags: list[dict[str, Any]]
    evidence: EvidenceTrace
    audit: dict[str, Any]


# ─── Загрузка конфигурации версии модели ─────────────────────────

def load_model_config(model_version: str) -> dict[str, Any]:
    """
    Загружает неизменяемую конфигурацию модели по версии.
    Конфигурация хранится в model_configs/{version}/config.yaml
    и после публикации не изменяется.
    """
    import yaml
    from pathlib import Path

    config_path = Path(f"model_configs/{model_version}/config.yaml")
    if not config_path.exists():
        raise FileNotFoundError(
            f"Конфигурация модели {model_version} не найдена. "
            f"Проверьте путь: {config_path}"
        )

    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)

    # Проверка целостности конфигурации
    config_hash = hash_config(config)
    expected_hash = _get_published_hash(model_version)
    if expected_hash and config_hash != expected_hash:
        raise RuntimeError(
            f"Хеш конфигурации {model_version} не совпадает с опубликованным. "
            f"Возможно, файл был изменён после публикации."
        )

    return config


def hash_config(config: dict[str, Any]) -> str:
    """Вычисляет SHA-256 хеш конфигурации для фиксации версии."""
    config_str = json.dumps(config, sort_keys=True, ensure_ascii=False)
    return f"sha256:{hashlib.sha256(config_str.encode()).hexdigest()}"


def _get_published_hash(model_version: str) -> str | None:
    """Получает опубликованный хеш из журнала версий."""
    from pathlib import Path

    journal_path = Path("model_configs/versions.jsonl")
    if not journal_path.exists():
        return None

    with open(journal_path, "r", encoding="utf-8") as f:
        for line in f:
            entry = json.loads(line.strip())
            if entry["version"] == model_version:
                return entry.get("config_hash")
    return None


# ─── Валидация входных данных ─────────────────────────────────────

def validate_input(
    input_data: HealthInput,
    config: dict[str, Any],
) -> tuple[HealthInput, dict[str, Any]]:
    """
    Валидирует входные данные против конфигурации модели.
    Возвращает валидированные данные и отчёт о качестве.
    """
    quality_report = {
        "overall": "pass",
        "checks": [],
        "actionable_flags": [],
        "exclusion_flags": [],
    }

    config_features = _flatten_config_features(config)
    provided_features = {f.name for f in input_data.measurements if f.value is not None}
    required_features = {f["name"] for f in config_features if f.get("required", True)}

    # Проверка полноты
    missing = required_features - provided_features
    if missing:
        quality_report["checks"].append({
            "name": "completeness",
            "status": "warning",
            "detail": f"missing: {', '.join(sorted(missing))}",
            "missing_count": len(missing),
        })
        quality_report["actionable_flags"].append("incomplete")
        if quality_report["overall"] == "pass":
            quality_report["overall"] = "pass_with_warnings"

    # Проверка единиц измерения
    feature_units = {f.name: f.unit for f in input_data.measurements if f.value is not None}
    config_units = {f["name"]: f["unit"] for f in config_features}
    unit_mismatches = []
    for name, unit in feature_units.items():
        if name in config_units and unit != config_units[name]:
            unit_mismatches.append(f"{name}: expected {config_units[name]}, got {unit}")

    if unit_mismatches:
        quality_report["checks"].append({
            "name": "units",
            "status": "warning",
            "detail": "; ".join(unit_mismatches),
        })
        quality_report["actionable_flags"].append("unit_mismatch")
        if quality_report["overall"] == "pass":
            quality_report["overall"] = "pass_with_warnings"

    # Проверка качества сигнала
    low_quality = [
        f.name for f in input_data.measurements
        if f.value is not None and f.confidence < 0.7
    ]
    if low_quality:
        quality_report["checks"].append({
            "name": "signal_quality",
            "status": "warning",
            "detail": f"low confidence: {', '.join(low_quality)}",
        })
        quality_report["actionable_flags"].append("low_quality")
        if quality_report["overall"] == "pass":
            quality_report["overall"] = "pass_with_warnings"

    # Проверка артефактов
    high_artifact = [
        f.name for f in input_data.measurements
        if f.value is not None and f.artifact_pct > 10
    ]
    if high_artifact:
        quality_report["checks"].append({
            "name": "artifacts",
            "status": "fail",
            "detail": f"artifact_pct > 10: {', '.join(high_artifact)}",
        })
        quality_report["exclusion_flags"].append("high_artifact")
        quality_report["overall"] = "fail"

    if not quality_report["checks"]:
        quality_report["checks"].append({
            "name": "all", "status": "pass", "detail": "all checks passed"
        })

    return input_data, quality_report


def _flatten_config_features(config: dict[str, Any]) -> list[dict[str, Any]]:
    """Разворачивает иерархическую конфигурацию в плоский список признаков."""
    features = []
    for comp_key, comp in config["components"].items():
        for feat in comp["features"]:
            feat_copy = dict(feat)
            feat_copy["component"] = comp_key
            features.append(feat_copy)
    return features


# ─── Расчёт компонентов ──────────────────────────────────────────

def normalized_score(
    value: float,
    normal_range: list[float],
    feature_name: str,
) -> tuple[float, str]:
    """
    Нормализация значения в диапазон [0, 1].
    Значение в центре диапазона → 1.0.
    Значение на границе → 0.5.
    Значение за пределами → линейное убывание до 0.
    """
    low, high = normal_range
    mid = (low + high) / 2
    half_range = (high - low) / 2

    if half_range == 0:
        score = 1.0 if value == mid else 0.0
    else:
        deviation = abs(value - mid) / half_range
        if deviation <= 1.0:
            score = 1.0 - 0.5 * deviation
        else:
            # За пределами диапазона — линейное убывание
            score = max(0.0, 0.5 - 0.5 * (deviation - 1.0) / 2.0)

    formula_str = (
        f"normalized_score({value}, [{low}, {high}]) = {score:.4f}"
    )
    return score, formula_str


def binary_penalty(
    value: float,
    threshold: float,
    feature_name: str = "",
) -> tuple[float, str]:
    """
    Бинарный штраф: 1.0 если значение ниже порога, 0.0 если равно или выше.
    """
    score = 1.0 if value < threshold else 0.0
    formula_str = f"binary_penalty({value}, threshold={threshold}) = {score:.2f}"
    return score, formula_str


def calculate_component(
    validated: HealthInput,
    component_config: dict[str, Any],
) -> ComponentResult:
    """
    Рассчитывает один компонент HEALTH_ID (hBody, hMental, hSocial).
    """
    feature_map = {f.name: f for f in validated.measurements}

    feature_results = []
    weighted_sum = 0.0
    total_weight = 0.0
    formulas_applied = []

    for feat_config in component_config["features"]:
        feat_name = feat_config["name"]
        feat_input = feature_map.get(feat_name)

        if feat_input is None or feat_input.value is None:
            # Пропуск отсутствующего признака
            feature_results.append({
                "name": feat_name,
                "raw_value": None,
                "source": feat_config.get("source", "unknown"),
                "normalized_score": None,
                "normal_range": feat_config.get("normal_range"),
                "contribution_weight": feat_config["contribution_weight"],
                "contribution": 0.0,
                "quality": None,
                "missing": True,
            })
            continue

        # Выбор функции нормализации
        formula_type = feat_config.get("formula", "normalized_score")
        if formula_type == "normalized_score":
            score, formula_str = normalized_score(
                feat_input.value,
                feat_config["normal_range"],
                feat_name,
            )
        elif formula_type == "binary_penalty":
            score, formula_str = binary_penalty(
                feat_input.value,
                feat_config.get("threshold", 0.0),
                feat_name,
            )
        else:
            raise ValueError(f"Неизвестная формула: {formula_type}")

        formulas_applied.append(formula_str)

        contribution = score * feat_config["contribution_weight"]
        weighted_sum += contribution
        total_weight += feat_config["contribution_weight"]

        feature_results.append({
            "name": feat_name,
            "raw_value": feat_input.value,
            "unit": feat_input.unit,
            "source": feat_input.source,
            "normalized_score": round(score, 4),
            "normal_range": feat_config.get("normal_range"),
            "contribution_weight": feat_config["contribution_weight"],
            "contribution": round(contribution, 4),
            "quality": {
                "confidence": feat_input.confidence,
                "artifact_pct": feat_input.artifact_pct,
            },
            "missing": False,
        })

    # Нормализация с учётом пропущенных признаков
    component_score = weighted_sum / total_weight if total_weight > 0 else 0.0

    component_weight = component_config["weight"]
    contribution = component_score * component_weight

    return ComponentResult(
        name=component_config.get("name", "unknown"),
        score=round(component_score, 4),
        weight=component_weight,
        contribution=round(contribution, 4),
        contribution_pct=round(component_weight * 100, 2),
        features=feature_results,
    ), formulas_applied


# ─── Оценка полноты и неопределённости ────────────────────────────

def calculate_completeness(validated: HealthInput, config: dict[str, Any]) -> dict[str, Any]:
    """Рассчитывает долю присутствующих обязательных признаков."""
    config_features = _flatten_config_features(config)
    required = [f for f in config_features if f.get("required", True)]
    required_names = {f["name"] for f in required}

    provided = {
        f.name for f in validated.measurements
        if f.value is not None
    }

    present = required_names & provided
    missing = required_names - provided
    overall = len(present) / len(required_names) if required_names else 1.0

    return {
        "overall": round(overall, 4),
        "required_features_present": len(present),
        "required_features_total": len(required_names),
        "missing": sorted(missing),
        "missing_impact": _assess_missing_impact(missing, config),
    }


def _assess_missing_impact(missing: set[str], config: dict[str, Any]) -> str:
    """Оценивает влияние отсутствующих признаков на результат."""
    if not missing:
        return "none"
    for comp_key, comp in config["components"].items():
        comp_features = {f["name"] for f in comp["features"]}
        if missing & comp_features:
            missing_in_comp = missing & comp_features
            if len(missing_in_comp) == len(comp_features):
                return f"{comp_key} cannot be calculated"
            return f"{comp_key} partially estimated"
    return "minimal"


def estimate_uncertainty(
    validated: HealthInput,
    components: list[ComponentResult],
) -> dict[str, Any]:
    """
    Оценивает неопределённость результата.
    Источники: пропущенные признаки, низкая confidence, артефакты.
    """
    sources = []
    total_impact = 0.0

    for feat in validated.measurements:
        if feat.value is None:
            continue
        if feat.confidence < 0.7:
            impact = (0.7 - feat.confidence) * 0.1
            sources.append({
                "type": "measurement_confidence",
                "feature": feat.name,
                "impact": round(impact, 4),
            })
            total_impact += impact

        if feat.artifact_pct > 5:
            impact = (feat.artifact_pct - 5) / 100 * 0.05
            sources.append({
                "type": "artifact",
                "feature": feat.name,
                "impact": round(impact, 4),
            })
            total_impact += impact

    # Добавление неопределённости от пропущенных признаков
    for comp in components:
        missing_count = sum(1 for f in comp.features if f.get("missing"))
        if missing_count > 0:
            impact = missing_count * 0.03
            sources.append({
                "type": "missing_feature",
                "component": comp.name,
                "count": missing_count,
                "impact": round(impact, 4),
            })
            total_impact += impact

    return {
        "overall": round(min(total_impact, 1.0), 4),
        "sources": sources,
    }


# ─── Классификация состояния ──────────────────────────────────────

def classify_state(
    validated: HealthInput,
    config: dict[str, Any],
    baseline: dict[str, Any] | None = None,
    history: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """
    Классифицирует состояние работника по трём категориям:
    - acute_deviation
    - persistent_repeated_deviation
    - confirmed_chronic (только из МИС/ЭМК)
    """
    flags = []

    # Проверка острого отклонения
    if baseline and baseline.get("available"):
        for feat_name, corridor in baseline["features"].items():
            if not corridor.get("available"):
                continue
            feat_input = next(
                (f for f in validated.measurements if f.name == feat_name),
                None,
            )
            if feat_input is None or feat_input.value is None:
                continue

            low = corridor["corridor_low"]
            high = corridor["corridor_high"]
            sigma = corridor["std"] if corridor["std"] > 0 else 1.0

            if feat_input.value > high + 2 * sigma or feat_input.value < low - 2 * sigma:
                deviation_type = "above_corridor" if feat_input.value > high else "below_corridor"
                z_score = abs(feat_input.value - corridor["mean"]) / sigma
                flags.append({
                    "flag": "acute_deviation",
                    "active": True,
                    "feature": feat_name,
                    "value": feat_input.value,
                    "corridor_low": round(low, 2),
                    "corridor_high": round(high, 2),
                    "deviation_type": deviation_type,
                    "sigma": round(z_score, 2),
                })

    if not any(f["flag"] == "acute_deviation" and f["active"] for f in flags):
        flags.append({"flag": "acute_deviation", "active": False, "details": None})

    # Проверка устойчивого повторного отклонения
    if history:
        unique_dates_with_deviation = set()
        for event in history:
            if event.get("has_acute_deviation"):
                # ⚠️ Считаем по уникальным датам, а не по числу попыток
                date_only = event["timestamp"][:10]  # YYYY-MM-DD
                unique_dates_with_deviation.add(date_only)

        if len(unique_dates_with_deviation) >= 3:
            flags.append({
                "flag": "persistent_repeated_deviation",
                "active": True,
                "unique_dates": sorted(unique_dates_with_deviation),
                "date_count": len(unique_dates_with_deviation),
                "note": "Counted by unique dates, not by number of attempts",
            })
        else:
            flags.append({
                "flag": "persistent_repeated_deviation",
                "active": False,
                "details": f"only {len(unique_dates_with_deviation)} unique dates with deviation",
            })
    else:
        flags.append({
            "flag": "persistent_repeated_deviation",
            "active": False,
            "details": "no history available",
        })

    # Хроническое состояние — только из МИС/ЭМК
    chronic_from_mis = validated.context.get("chronic_conditions", [])
    if chronic_from_mis:
        flags.append({
            "flag": "confirmed_chronic",
            "active": True,
            "source": "MIS/EMK",
            "conditions": chronic_from_mis,
            "note": "Source: MIS/EMK only. NOT from HEALTH_ID calculation.",
        })
    else:
        flags.append({
            "flag": "confirmed_chronic",
            "active": False,
            "details": None,
        })

    return flags


# ─── Сборка evidence ─────────────────────────────────────────────

def build_evidence(
    input_data: HealthInput,
    config: dict[str, Any],
    components: list[tuple[ComponentResult, list[str]]],
    quality_report: dict[str, Any],
    baseline: dict[str, Any] | None = None,
) -> EvidenceTrace:
    """Собирает полный evidence trace для прослеживаемости."""
    all_formulas = []
    contribution_trace = {}

    for comp, formulas in components:
        all_formulas.extend(formulas)
        contribution_trace[comp.name] = {
            "score": comp.score,
            "weight": comp.weight,
            "product": round(comp.score * comp.weight, 4),
            "features": {
                f["name"]: {
                    "score": f.get("normalized_score"),
                    "weight": f.get("contribution_weight"),
                    "product": f.get("contribution"),
                }
                for f in comp.features
            },
        }

    total = sum(c.score * c.weight for c, _ in components)
    contribution_trace["total"] = round(total, 4)

    return EvidenceTrace(
        input_ids=[input_data.event_id],
        quality_reports=[quality_report],
        formulas_applied=all_formulas,
        norms_used={
            f["name"]: f.get("normal_range")
            for f in _flatten_config_features(config)
        },
        contribution_trace=contribution_trace,
        baseline_used={
            "available": baseline.get("available", False),
            "n_historical_points": baseline.get("n_points", 0),
            "window_days": baseline.get("window_days", 90),
            "excluded_event": baseline.get("excluded_event"),
        } if baseline else None,
        model_card_ref=config.get("model_version", "unknown"),
    )


# ─── Главная функция ──────────────────────────────────────────────

def calculate_health_id(
    input_data: HealthInput,
    model_version: str,
    baseline: dict[str, Any] | None = None,
    history: list[dict[str, Any]] | None = None,
) -> HealthResult:
    """
    Полный пайплайн расчёта HEALTH_ID.

    Параметры:
        input_data: входной пакет данных ПрМО
        model_version: версия модели (например, 'health_id_v1.0.0')
        baseline: персональные коридоры (с уже исключённой текущей точкой)
        history: история событий для классификации повторных отклонений

    Возвращает:
        HealthResult — выходной контракт с полным evidence
    """
    # 1. Загрузка неизменяемой конфигурации версии
    config = load_model_config(model_version)

    # 2. Валидация входных данных
    validated, quality_report = validate_input(input_data, config)

    # Если качество — fail, не выполняем расчёт
    if quality_report["overall"] == "fail":
        return _build_failed_result(
            input_data, model_version, quality_report, config
        )

    # 3. Расчёт компонентов
    comp_results = []
    for comp_key in ["hBody", "hMental", "hSocial"]:
        comp_config = config["components"][comp_key]
        comp_config["name"] = comp_key
        comp_result, formulas = calculate_component(validated, comp_config)
        comp_results.append((comp_result, formulas))

    # 4. Расчёт итогового индекса
    health_id_value = sum(
        c.score * c.weight for c, _ in comp_results
    )

    # 5. Оценка неопределённости и полноты
    uncertainty = estimate_uncertainty(validated, [c for c, _ in comp_results])
    completeness = calculate_completeness(validated, config)

    # 6. Классификация состояния
    state_flags = classify_state(validated, config, baseline, history)

    # 7. Определение категории (green / yellow / red)
    thresholds = config.get("thresholds", {})
    category = _determine_category(health_id_value, thresholds)

    # 8. Формирование evidence
    evidence = build_evidence(
        input_data=validated,
        config=config,
        components=comp_results,
        quality_report=quality_report,
        baseline=baseline,
    )

    # 9. Формирование выходного контракта
    config_hash = hash_config(config)
    result_id = f"res_{uuid.uuid4().hex[:12]}"

    result = HealthResult(
        result_id=result_id,
        event_id=input_data.event_id,
        worker_pseudonym=input_data.worker_pseudonym,
        timestamp=datetime.now(timezone.utc).isoformat(),
        health_id={
            "value": round(health_id_value, 4),
            "category": category,
            "model_version": model_version,
            "config_snapshot_hash": config_hash,
            "disclaimer": "Исследовательский результат. Не является медицинским диагнозом.",
        },
        components={
            comp.name: comp for comp, _ in comp_results
        },
        completeness=completeness,
        uncertainty=uncertainty,
        state_flags=state_flags,
        evidence=evidence,
        audit={
            "calculation_timestamp": datetime.now(timezone.utc).isoformat(),
            "config_snapshot_hash": config_hash,
            "quality_report_hash": hashlib.sha256(
                json.dumps(quality_report, sort_keys=True).encode()
            ).hexdigest()[:16],
            "reproducible": True,
        },
    )

    return result


def _determine_category(value: float, thresholds: dict[str, list[float]]) -> str:
    """Определяет категорию HEALTH_ID по порогам."""
    if not thresholds:
        return "unknown"
    green = thresholds.get("green", [0.80, 1.00])
    yellow = thresholds.get("yellow", [0.60, 0.80])
    red = thresholds.get("red", [0.00, 0.60])

    if green[0] <= value <= green[1]:
        return "green"
    elif yellow[0] <= value < yellow[1]:
        return "yellow"
    elif red[0] <= value < red[1]:
        return "red"
    return "unknown"


def _build_failed_result(
    input_data: HealthInput,
    model_version: str,
    quality_report: dict[str, Any],
    config: dict[str, Any],
) -> HealthResult:
    """Формирует результат при провале контроля качества."""
    return HealthResult(
        result_id=f"res_{uuid.uuid4().hex[:12]}",
        event_id=input_data.event_id,
        worker_pseudonym=input_data.worker_pseudonym,
        timestamp=datetime.now(timezone.utc).isoformat(),
        health_id={
            "value": None,
            "category": "not_calculated",
            "model_version": model_version,
            "config_snapshot_hash": hash_config(config),
            "disclaimer": "Исследовательский результат. Не является медицинским диагнозом.",
            "reason": "quality_check_failed",
        },
        components={},
        completeness={"overall": 0.0, "missing": [], "missing_impact": "n/a"},
        uncertainty={"overall": 1.0, "sources": [
            {"type": "quality_failure", "impact": 1.0}
        ]},
        state_flags=[],
        evidence=EvidenceTrace(
            input_ids=[input_data.event_id],
            quality_reports=[quality_report],
            formulas_applied=[],
            norms_used={},
            contribution_trace={},
            baseline_used=None,
            model_card_ref=model_version,
        ),
        audit={
            "calculation_timestamp": datetime.now(timezone.utc).isoformat(),
            "config_snapshot_hash": hash_config(config),
            "reproducible": True,
            "quality_status": "fail",
        },
    )
```
##  Шаблон расчёта персональных коридоров (baseline)
```python
"""
Расчёт персональных коридоров (baseline) с защитой от утечки данных.
Ключевой принцип: текущее измерение НИКОГДА не входит в свой baseline.
"""
from __future__ import annotations

import numpy as np
from datetime import datetime, timedelta
from typing import Any


def calculate_baseline(
    worker_pseudonym: str,
    current_event_id: str,
    history: list[dict[str, Any]],
    window_days: int = 90,
    min_points: int = 3,
    quality_filter: str = "pass",
) -> dict[str, Any]:
    """
    Рассчитывает персональные коридоры для работника.

    Параметры:
        worker_pseudonym: псевдоним работника
        current_event_id: ID текущего события (ИСКЛЮЧАЕТСЯ из baseline)
        history: история событий
        window_days: окно наблюдения в днях
        min_points: минимум точек для построения коридора
        quality_filter: фильтр качества ("pass" / "pass_with_warnings" / "any")

    Возвращает:
        Словарь с коридорами по каждому признаку
    """
    # Фильтрация по работнику
    worker_history = [
        h for h in history
        if h.get("worker_pseudonym") == worker_pseudonym
    ]

    # ⚠️ КРИТИЧЕСКОЕ ИСКЛЮЧЕНИЕ текущей точки
    worker_history = [
        h for h in worker_history
        if h.get("event_id") != current_event_id
    ]

    # Фильтр по окну времени
    cutoff_date = datetime.now() - timedelta(days=window_days)
    worker_history = [
        h for h in worker_history
        if _parse_date(h.get("timestamp", "")) >= cutoff_date
    ]

    # Фильтр по качеству
    if quality_filter != "any":
        worker_history = [
            h for h in worker_history
            if h.get("quality_status", "pass") in (
                ["pass"] if quality_filter == "pass"
                else ["pass", "pass_with_warnings"]
            )
        ]

    if len(worker_history) < min_points:
        return {
            "available": False,
            "reason": "insufficient_history",
            "n_points": len(worker_history),
            "min_points": min_points,
            "excluded_event": current_event_id,
            "window_days": window_days,
        }

    # Сбор значений по признакам
    baseline = {"available": True, "features": {}}
    all_feature_names = set()
    for h in worker_history:
        measurements = h.get("measurements", {})
        all_feature_names.update(measurements.keys())

    for feature_name in all_feature_names:
        values = []
        source_events = []

        for h in worker_history:
            measurements = h.get("measurements", {})
            if feature_name in measurements and measurements[feature_name] is not None:
                values.append(measurements[feature_name])
                source_events.append(h["event_id"])

        if len(values) < min_points:
            baseline["features"][feature_name] = {
                "available": False,
                "reason": "insufficient_points",
                "n_points": len(values),
            }
            continue

        arr = np.array(values, dtype=float)
        mean = float(np.mean(arr))
        std = float(np.std(arr, ddof=1)) if len(arr) > 1 else 0.0
        median = float(np.median(arr))

        baseline["features"][feature_name] = {
            "available": True,
            "mean": round(mean, 4),
            "std": round(std, 4),
            "median": round(median, 4),
            "p5": round(float(np.percentile(arr, 5)), 4),
            "p95": round(float(np.percentile(arr, 95)), 4),
            "corridor_low": round(mean - 2 * std, 4) if std > 0 else round(mean * 0.9, 4),
            "corridor_high": round(mean + 2 * std, 4) if std > 0 else round(mean * 1.1, 4),
            "n_points": len(values),
            "source_events": source_events,
            "window_days": window_days,
            "excluded_event": current_event_id,
        }

    baseline["n_points"] = len(worker_history)
    baseline["window_days"] = window_days
    baseline["excluded_event"] = current_event_id

    # Проверка дрейфа baseline
    baseline["drift_check"] = _check_baseline_drift(worker_history)

    return baseline


def _check_baseline_drift(history: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Проверяет дрейф baseline: сравнивает первую и последнюю трети истории.
    Если средние различаются значимо (t-тест, p < 0.05) — помечает дрейф.
    """
    if len(history) < 6:
        return {"checked": False, "reason": "insufficient_data"}

    from scipy import stats

    third = len(history) // 3
    first_third = history[:third]
    last_third = history[-third:]

    # Сбор значений для сравнения (по первому доступному признаку)
    drift_flags = []
    all_features = set()
    for h in history:
        all_features.update(h.get("measurements", {}).keys())

    for feat in all_features:
        v1 = [h["measurements"][feat] for h in first_third
              if h.get("measurements", {}).get(feat) is not None]
        v2 = [h["measurements"][feat] for h in last_third
              if h.get("measurements", {}).get(feat) is not None]

        if len(v1) < 2 or len(v2) < 2:
            continue

        t_stat, p_value = stats.ttest_ind(v1, v2, equal_var=False)
        if p_value < 0.05:
            drift_flags.append({
                "feature": feat,
                "p_value": round(p_value, 4),
                "direction": "increase" if np.mean(v2) > np.mean(v1) else "decrease",
            })

    return {
        "checked": True,
        "drift_detected": len(drift_flags) > 0,
        "drifted_features": drift_flags,
    }


def _parse_date(date_str: str) -> datetime:
    """Парсит ISO-8601 дату с обработкой ошибок."""
    try:
        return datetime.fromisoformat(date_str.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return datetime.min
```
##  Шаблон контроля качества видео для верификации
```python
"""
Контроль качества видеопотока для биометрической верификации.
Все результаты сохраняются в аудит. Исходные видео не хранятся.
"""
from __future__ import annotations

import cv2
import numpy as np
from dataclasses import dataclass, field
from typing import Any


QUALITY_CHECKS = {
    "resolution": {"min": (640, 480), "actual": None},
    "fps": {"min": 15, "actual": None},
    "lighting": {"min_lux": 100, "actual": None},
    "face_visibility": {"min_area_pct": 5, "actual": None},
    "blur": {"max_variance": 35, "actual": None},
    "occlusion": {"max_pct": 10, "actual": None},
    "angle": {"max_yaw": 25, "max_pitch": 20, "max_roll": 15, "actual": None},
    "duration": {"min_sec": 3, "actual": None},
}


@dataclass
class QualityResult:
    overall: str  # "pass" | "warning" | "fail"
    checks: dict[str, dict[str, Any]] = field(default_factory=dict)
    blocking_issues: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def check_video_quality(
    video_path: str,
    face_detector: Any = None,
) -> QualityResult:
    """
    Полная проверка качества видеопотока.
    Возвращает структурированный отчёт.
    """
    result = QualityResult(overall="pass")

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        result.overall = "fail"
        result.blocking_issues.append("cannot_open_video")
        return result

    # Метаданные видео
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration_sec = frame_count / fps if fps > 0 else 0

    # 1. Разрешение
    min_w, min_h = QUALITY_CHECKS["resolution"]["min"]
    res_pass = width >= min_w and height >= min_h
    result.checks["resolution"] = {
        "status": "pass" if res_pass else "fail",
        "actual": (width, height),
        "required": (min_w, min_h),
    }
    if not res_pass:
        result.blocking_issues.append("resolution_too_low")

    # 2. FPS
    fps_pass = fps >= QUALITY_CHECKS["fps"]["min"]
    result.checks["fps"] = {
        "status": "pass" if fps_pass else "warning",
        "actual": round(fps, 1),
        "required": QUALITY_CHECKS["fps"]["min"],
    }
    if not fps_pass:
        result.warnings.append("low_fps")

    # 3. Длительность
    dur_pass = duration_sec >= QUALITY_CHECKS["duration"]["min_sec"]
    result.checks["duration"] = {
        "status": "pass" if dur_pass else "fail",
        "actual": round(duration_sec, 2),
        "required": QUALITY_CHECKS["duration"]["min_sec"],
    }
    if not dur_pass:
        result.blocking_issues.append("duration_too_short")

    # Покадровый анализ (каждый N-й кадр)
    sample_interval = max(1, frame_count // 30)  # ~30 кадров для анализа
    blur_values = []
    face_areas = []
    lighting_values = []
    angles = []
    occlusion_flags = []

    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % sample_interval == 0:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

            # Размытие (Laplacian variance — выше = резче)
            blur_var = cv2.Laplacian(gray, cv2.CV_64F).var()
            blur_values.append(blur_var)

            # Освещённость (средняя яркость как proxy для lux)
            brightness = np.mean(gray)
            lighting_values.append(float(brightness))

            # Обнаружение лица
            if face_detector is not None:
                faces = face_detector.detect(frame)
                if faces:
                    face = faces[0]
                    face_area = (face.w * face.h) / (width * height) * 100
                    face_areas.append(face_area)

                    # Углы наклона головы
                    if hasattr(face, "yaw"):
                        angles.append({
                            "yaw": face.yaw,
                            "pitch": face.pitch,
                            "roll": face.roll,
                        })

                    # Окклюзия (упрощённая проверка)
                    if hasattr(face, "occlusion_pct"):
                        if face.occlusion_pct > QUALITY_CHECKS["occlusion"]["max_pct"]:
                            occlusion_flags.append(frame_idx)
                else:
                    face_areas.append(0.0)

        frame_idx += 1

    cap.release()

    # 4. Размытие
    if blur_values:
        avg_blur = float(np.mean(blur_values))
        blur_pass = avg_blur >= QUALITY_CHECKS["blur"]["max_variance"]
        result.checks["blur"] = {
            "status": "pass" if blur_pass else "warning",
            "actual": round(avg_blur, 2),
            "required": QUALITY_CHECKS["blur"]["max_variance"],
        }
        if not blur_pass:
            result.warnings.append("blur_detected")

    # 5. Видимость лица
    if face_areas:
        avg_face_area = float(np.mean(face_areas))
        face_pass = avg_face_area >= QUALITY_CHECKS["face_visibility"]["min_area_pct"]
        result.checks["face_visibility"] = {
            "status": "pass" if face_pass else "fail",
            "actual": round(avg_face_area, 2),
            "required": QUALITY_CHECKS["face_visibility"]["min_area_pct"],
        }
        if not face_pass:
            result.blocking_issues.append("face_too_small")

    # 6. Освещённость
    if lighting_values:
        avg_light = float(np.mean(lighting_values))
        # Proxy: brightness > 60 ≈ приемлемое освещение
        light_pass = avg_light >= 60
        result.checks["lighting"] = {
            "status": "pass" if light_pass else "warning",
            "actual": round(avg_light, 2),
            "note": "Brightness-based proxy, not true lux measurement",
        }
        if not light_pass:
            result.warnings.append("low_lighting")

    # 7. Углы наклона
    if angles:
        max_yaw = max(abs(a["yaw"]) for a in angles)
        max_pitch = max(abs(a["pitch"]) for a in angles)
        max_roll = max(abs(a["roll"]) for a in angles)

        yaw_pass = max_yaw <= QUALITY_CHECKS["angle"]["max_yaw"]
        pitch_pass = max_pitch <= QUALITY_CHECKS["angle"]["max_pitch"]
        roll_pass = max_roll <= QUALITY_CHECKS["angle"]["max_roll"]

        angle_pass = yaw_pass and pitch_pass and roll_pass
        result.checks["angle"] = {
            "status": "pass" if angle_pass else "warning",
            "actual": {
                "max_yaw": round(max_yaw, 1),
                "max_pitch": round(max_pitch, 1),
                "max_roll": round(max_roll, 1),
            },
            "required": {
                "max_yaw": QUALITY_CHECKS["angle"]["max_yaw"],
                "max_pitch": QUALITY_CHECKS["angle"]["max_pitch"],
                "max_roll": QUALITY_CHECKS["angle"]["max_roll"],
            },
        }
        if not angle_pass:
            result.warnings.append("head_angle_exceeded")

    # 8. Окклюзия
    occlusion_pass = len(occlusion_flags) == 0
    result.checks["occlusion"] = {
        "status": "pass" if occlusion_pass else "warning",
        "actual": len(occlusion_flags),
        "required": 0,
    }
    if not occlusion_pass:
        result.warnings.append("occlusion_detected")

    # Итоговый статус
    if result.blocking_issues:
        result.overall = "fail"
    elif result.warnings:
        result.overall = "warning"
    else:
        result.overall = "pass"

    return result
```
## Шаблон маршрутизации результатов верификации
```python
"""
Маршрутизация результатов биометрической верификации.
Определяет: verified / manual_review / not_verified.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


# Пороговые значения (настраиваемые)
THRESHOLDS = {
    "match_high": 0.62,       # >= → verified
    "match_low": 0.45,        # < → not_verified
    "liveness_pass": 0.70,    # >= → liveness confirmed
    "liveness_warning": 0.50, # >= → manual_review
}


@dataclass
class VerificationResult:
    route: str  # "verified" | "manual_review" | "not_verified"
    match_score: float
    liveness_score: float
    quality_overall: str
    details: dict[str, Any]
    audit: dict[str, Any]


def route_verification(
    match_score: float,
    liveness_score: float,
    quality_result: dict[str, Any],
    session_id: str,
    model_version: str = "face_v1.0.0",
) -> VerificationResult:
    """
    Определяет маршрут результата верификации.

    Логика:
        verified      — match >= 0.62 AND liveness >= 0.70 AND quality == pass
        manual_review — 0.45 <= match < 0.62 OR liveness 0.50–0.70 OR quality == warning
        not_verified  — match < 0.45 OR liveness < 0.50 OR quality == fail
    """
    quality_overall = quality_result.get("overall", "fail")

    # Определение маршрута
    if (match_score >= THRESHOLDS["match_high"]
            and liveness_score >= THRESHOLDS["liveness_pass"]
            and quality_overall == "pass"):
        route = "verified"
    elif (match_score < THRESHOLDS["match_low"]
          or liveness_score < THRESHOLDS["liveness_warning"]
          or quality_overall == "fail"):
        route = "not_verified"
    else:
        route = "manual_review"

    # Детали для аудита
    details = {
        "match_category": _categorize_match(match_score),
        "liveness_category": _categorize_liveness(liveness_score),
        "quality_category": quality_overall,
        "thresholds_used": THRESHOLDS,
        "blocking_quality_issues": quality_result.get("blocking_issues", []),
        "quality_warnings": quality_result.get("warnings", []),
    }

    audit = {
        "session_id": session_id,
        "model_version": model_version,
        "route": route,
        "match_score": match_score,
        "liveness_score": liveness_score,
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


def _categorize_match(score: float) -> str:
    if score >= THRESHOLDS["match_high"]:
        return "high"
    elif score >= THRESHOLDS["match_low"]:
        return "medium"
    return "low"


def _categorize_liveness(score: float) -> str:
    if score >= THRESHOLDS["liveness_pass"]:
        return "confirmed"
    elif score >= THRESHOLDS["liveness_warning"]:
        return "uncertain"
    return "failed"


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
```
# Шаблон Human Review сервиса
```python
"""
Сервис ручной проверки (Human Review) для спорных случаев верификации.
Статусы: pending → confirmed / rejected.
После закрытия — статус неизменяем.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class ReviewStatus(str, Enum):
    PENDING = "pending"
    CONFIRMED = "confirmed"
    REJECTED = "rejected"
    INFO_REQUESTED = "info_requested"  # запрошена доп. информация


class ReviewTrigger(str, Enum):
    MANUAL_REVIEW_ROUTE = "manual_review_route"
    ACUTE_DEVIATION = "acute_deviation"
    PERSISTENT_DEVIATION = "persistent_deviation"


class ReviewCreate(BaseModel):
    session_id: str
    event_id: str
    trigger_reason: ReviewTrigger
    trigger_data: dict[str, Any] = Field(default_factory=dict)
    assigned_to: str  # pseudonym медработника


class ReviewUpdate(BaseModel):
    review_id: str
    status: ReviewStatus
    reviewer_comment: str
    evidence: list[dict[str, Any]] = Field(default_factory=list)


class Review(BaseModel):
    review_id: str
    session_id: str
    event_id: str
    status: ReviewStatus
    trigger_reason: ReviewTrigger
    trigger_data: dict[str, Any]
    assigned_to: str
    created_at: str
    resolved_at: str | None = None
    reviewer_comment: str = ""
    evidence: list[dict[str, Any]] = Field(default_factory=list)
    audit: dict[str, Any] = Field(default_factory=dict)


# ─── Хранилище (в реальности — PostgreSQL) ───────────────────────

_reviews_store: dict[str, Review] = {}
_audit_chain: list[dict[str, Any]] = []


def create_review(create: ReviewCreate) -> Review:
    """Создаёт новую запись на ручную проверку."""
    review_id = f"rev_{uuid.uuid4().hex[:12]}"
    now = _now_iso()

    review = Review(
        review_id=review_id,
        session_id=create.session_id,
        event_id=create.event_id,
        status=ReviewStatus.PENDING,
        trigger_reason=create.trigger_reason,
        trigger_data=create.trigger_data,
        assigned_to=create.assigned_to,
        created_at=now,
        audit={
            "created_at": now,
            "created_by": create.assigned_to,
            "status_history": [
                {"from": None, "to": "pending", "timestamp": now}
            ],
        },
    )

    _reviews_store[review_id] = review
    _add_audit(review, "create", create.assigned_to)

    return review


def update_review(update: ReviewUpdate, reviewer_pseudonym: str) -> Review:
    """
    Обновляет статус review.
    ⚠️ После confirmed/rejected — статус неизменяем.
    """
    review = _reviews_store.get(update.review_id)
    if review is None:
        raise ValueError(f"Review {update.review_id} not found")

    # Проверка неизменяемости закрытых review
    if review.status in (ReviewStatus.CONFIRMED, ReviewStatus.REJECTED):
        raise ValueError(
            f"Review {update.review_id} is already closed "
            f"(status: {review.status}). Closed reviews are immutable."
        )

    # Проверка комментария
    if update.status in (ReviewStatus.CONFIRMED, ReviewStatus.REJECTED):
        if not update.reviewer_comment.strip():
            raise ValueError(
                "Comment is required for confirmed/rejected status"
            )

    now = _now_iso()
    previous_status = review.status
    review.status = update.status
    review.reviewer_comment = update.reviewer_comment
    review.evidence = update.evidence
    review.resolved_at = now if update.status in (
        ReviewStatus.CONFIRMED, ReviewStatus.REJECTED
    ) else None

    # Обновление аудита
    review.audit["status_history"].append({
        "from": previous_status,
        "to": update.status,
        "timestamp": now,
        "reviewer": reviewer_pseudonym,
    })

    _reviews_store[update.review_id] = review
    _add_audit(review, "update", reviewer_pseudonym, previous_status)

    return review


def get_review(review_id: str) -> Review | None:
    """Получает review по ID."""
    return _reviews_store.get(review_id)


def get_pending_reviews(assigned_to: str | None = None) -> list[Review]:
    """Получает список pending review, опционально фильтрует по медработнику."""
    pending = [
        r for r in _reviews_store.values()
        if r.status == ReviewStatus.PENDING
    ]
    if assigned_to:
        pending = [r for r in pending if r.assigned_to == assigned_to]
    return pending


def _add_audit(
    review: Review,
    action: str,
    actor: str,
    previous_status: str | None = None,
) -> None:
    """Добавляет запись в неизменяемый аудит-лог."""
    entry = {
        "id": f"aud_{uuid.uuid4().hex[:12]}",
        "timestamp": _now_iso(),
        "action": action,
        "review_id": review.review_id,
        "actor": actor,
        "previous_status": previous_status,
        "new_status": review.status,
        "immutable": True,
    }
    _audit_chain.append(entry)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
```
# Шаблон конфигурации модели (config.yaml)
```yaml
# model_configs/health_id_v1.0.0/config.yaml
# ⚠️ После публикации — файл замораживается. Изменения → новая версия.

model_version: "health_id_v1.0.0"
status: "research"
created_at: "2026-09-15"

components:
  hBody:
    weight: 0.60
    features:
      - name: "heart_rate"
        unit: "bpm"
        source: "measured"
        normal_range: [60, 90]
        required: true
        quality_thresholds:
          min_confidence: 0.8
          max_artifact_pct: 5
        formula: "normalized_score"
        contribution_weight: 0.25

      - name: "blood_pressure_systolic"
        unit: "mmHg"
        source: "measured"
        normal_range: [100, 130]
        required: true
        formula: "normalized_score"
        contribution_weight: 0.25

      - name: "blood_pressure_diastolic"
        unit: "mmHg"
        source: "measured"
        normal_range: [60, 85]
        required: true
        formula: "normalized_score"
        contribution_weight: 0.20

      - name: "temperature"
        unit: "celsius"
        source: "measured"
        normal_range: [36.1, 37.2]
        required: true
        formula: "normalized_score"
        contribution_weight: 0.15

      - name: "spo2"
        unit: "percent"
        source: "measured"
        normal_range: [95, 100]
        required: true
        formula: "normalized_score"
        contribution_weight: 0.10

      - name: "alcohol_test"
        unit: "mg/l"
        source: "measured"
        normal_range: [0, 0.15]
        required: true
        formula: "binary_penalty"
        threshold: 0.16
        contribution_weight: 0.05

  hMental:
    weight: 0.25
    features:
      - name: "adequacy_score"
        unit: "score"
        source: "measured"
        normal_range: [7, 10]
        required: true
        formula: "normalized_score"
        contribution_weight: 0.40

      - name: "speech_coherence"
        unit: "score"
        source: "derived"
        normal_range: [7, 10]
        required: false
        formula: "normalized_score"
        contribution_weight: 0.35

      - name: "pupil_reaction"
        unit: "score"
        source: "measured"
        normal_range: [7, 10]
        required: true
        formula: "normalized_score"
        contribution_weight: 0.25

  hSocial:
    weight: 0.15
    features:
      - name: "examination_regularity"
        unit: "ratio"
        source: "context"
        required: true
        formula: "normalized_score"
        normal_range: [0.8, 1.0]
        contribution_weight: 0.50

      - name: "missed_examinations"
        unit: "count"
        source: "context"
        required: true
        formula: "binary_penalty"
        threshold: 3
        contribution_weight: 0.50

thresholds:
  green: [0.80, 1.00]
  yellow: [0.60, 0.80]
  red: [0.00, 0.60]

uncertainty:
  min_completeness: 0.70
  partial_result: true

quality_rules:
  exclude_if:
    - "artifact_pct > 10"
    - "confidence < 0.7"
  flag_if:
    - "unit_mismatch"
    - "measurement_protocol_violation"
```
# Шаблон журнала версий (versions.jsonl)
```jsonl
{"version": "health_id_v1.0.0", "created_at": "2026-09-15", "status": "research", "changes": "initial release", "config_hash": "sha256:abc123def456", "parent": null}
{"version": "health_id_v1.0.1", "created_at": "2026-10-01", "status": "research", "changes": "adjusted spo2 normal range from [95,100] to [94,100]", "config_hash": "sha256:ghi789jkl012", "parent": "health_id_v1.0.0"}
{"version": "health_id_v1.1.0", "created_at": "2026-11-15", "status": "research", "changes": "added hMental.sleep_quality feature, weight redistribution in hMental", "config_hash": "sha256:mno345pqr678", "parent": "health_id_v1.0.1"}
```
# Шаблон FastAPI эндпоинтов
```python
"""
API эндпоинты для расчёта HEALTH_ID, получения результатов,
динамики состояния, human review и model card.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Depends
from pydantic import BaseModel

from app.core.engine.health_id_engine import calculate_health_id, HealthInput
from app.core.data.baseline import calculate_baseline
from app.core.review.review_service import (
    create_review, update_review, get_review, get_pending_reviews,
    ReviewCreate, ReviewUpdate, Review,
)

router = APIRouter(prefix="/api/v1", tags=["health_id"])


# ─── Расчёт HEALTH_ID ────────────────────────────────────────────

class CalculateRequest(BaseModel):
    event_id: str
    model_version: str = "health_id_v1.0.0"


class CalculateResponse(BaseModel):
    result_id: str
    status: str
    health_id: dict | None = None


@router.post("/calculate", response_model=CalculateResponse)
async def calculate(req: CalculateRequest):
    """
    Запуск расчёта HEALTH_ID для события ПрМО.
    """
    # Загрузка входных данных из БД по event_id
    input_data = await _load_event_data(req.event_id)
    if input_data is None:
        raise HTTPException(404, f"Event {req.event_id} not found")

    # Загрузка истории для baseline
    history = await _load_history(input_data.worker_pseudonym)

    # Расчёт baseline с исключением текущей точки
    baseline = calculate_baseline(
        worker_pseudonym=input_data.worker_pseudonym,
        current_event_id=req.event_id,
        history=history,
    )

    # Расчёт HEALTH_ID
    result = calculate_health_id(
        input_data=input_data,
        model_version=req.model_version,
        baseline=baseline,
        history=history,
    )

    # Сохранение результата
    await _save_result(result)

    return CalculateResponse(
        result_id=result.result_id,
        status="calculated" if result.health_id.get("value") is not None else "quality_failed",
        health_id=result.health_id,
    )


# ─── Получение результата ────────────────────────────────────────

@router.get("/results/{result_id}")
async def get_result(result_id: str):
    """Получение полного результата по ID."""
    result = await _load_result(result_id)
    if result is None:
        raise HTTPException(404, f"Result {result_id} not found")
    return result


@router.get("/results")
async def list_results(
    worker_pseudonym: str | None = None,
    model_version: str | None = None,
    category: str | None = None,
    limit: int = Query(50, le=200),
    cursor: str | None = None,
):
    """Список результатов с фильтрами и пагинацией."""
    return await _query_results(
        worker_pseudonym=worker_pseudonym,
        model_version=model_version,
        category=category,
        limit=limit,
        cursor=cursor,
    )


# ─── Динамика состояния ──────────────────────────────────────────

@router.get("/dynamics/{worker_pseudonym}")
async def get_dynamics(
    worker_pseudonym: str,
    window_days: int = Query(90, ge=7, le=365),
):
    """Динамика состояния работника за период."""
    history = await _load_history(worker_pseudonym, window_days)
    return {
        "worker_pseudonym": worker_pseudonym,
        "window_days": window_days,
        "events": history,
        "summary": _summarize_dynamics(history),
    }


# ─── Human Review ────────────────────────────────────────────────

@router.post("/review", response_model=Review)
async def create_review_endpoint(req: ReviewCreate):
    """Создание записи на ручную проверку."""
    return create_review(req)


@router.patch("/review", response_model=Review)
async def update_review_endpoint(req: ReviewUpdate, reviewer_pseudonym: str = Depends(...)):
    """Обновление статуса ручной проверки."""
    try:
        return update_review(req, reviewer_pseudonym)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/review/{review_id}", response_model=Review)
async def get_review_endpoint(review_id: str):
    """Получение статуса review по ID."""
    review = get_review(review_id)
    if review is None:
        raise HTTPException(404, f"Review {review_id} not found")
    return review


@router.get("/reviews/pending", response_model=list[Review])
async def get_pending_reviews_endpoint(
    assigned_to: str | None = None,
):
    """Список pending review."""
    return get_pending_reviews(assigned_to)


# ─── Model Card и версии ─────────────────────────────────────────

@router.get("/model-card")
async def get_current_model_card():
    """Текущая model card."""
    return await _load_model_card("latest")


@router.get("/model-card/{version}")
async def get_model_card(version: str):
    """Model card по версии."""
    card = await _load_model_card(version)
    if card is None:
        raise HTTPException(404, f"Model card {version} not found")
    return card


@router.get("/versions")
async def get_versions():
    """Журнал версий модели."""
    return await _load_versions_journal()


# ─── Заглушки для БД (заменить на реальные запросы) ──────────────

async def _load_event_data(event_id: str) -> HealthInput | None: ...
async def _load_history(worker_pseudonym: str, window_days: int = 90) -> list[dict]: ...
async def _save_result(result) -> None: ...
async def _load_result(result_id: str) -> dict | None: ...
async def _query_results(**kwargs) -> dict: ...
async def _load_model_card(version: str) -> dict | None: ...
async def _load_versions_journal() -> list[dict]: ...
def _summarize_dynamics(history: list[dict]) -> dict: ...
```
# Шаблон unit-тестов
```python
"""
Unit-тесты для движка HEALTH_ID, baseline и классификации.
Запуск: pytest tests/unit/ -v
"""
import pytest
import numpy as np
from datetime import datetime, timedelta

from app.core.engine.health_id_engine import (
    calculate_health_id, HealthInput, FeatureInput,
    normalized_score, binary_penalty,
)
from app.core.data.baseline import calculate_baseline
from app.core.classification.state_classifier import classify_state


# ─── Тесты формул ────────────────────────────────────────────────

class TestNormalizedScore:
    def test_center_of_range_returns_one(self):
        score, _ = normalized_score(75, [60, 90], "heart_rate")
        assert score == 1.0

    def test_edge_of_range_returns_half(self):
        score, _ = normalized_score(60, [60, 90], "heart_rate")
        assert abs(score - 0.5) < 0.01

    def test_outside_range_returns_low(self):
        score, _ = normalized_score(120, [60, 90], "heart_rate")
        assert score < 0.3

    def test_zero_range(self):
        score, _ = normalized_score(5, [5, 5], "const")
        assert score == 1.0


class TestBinaryPenalty:
    def test_below_threshold_returns_one(self):
        score, _ = binary_penalty(0.0, 0.16, "alcohol")
        assert score == 1.0

    def test_above_threshold_returns_zero(self):
        score, _ = binary_penalty(0.20, 0.16, "alcohol")
        assert score == 0.0

    def test_equal_threshold_returns_zero(self):
        score, _ = binary_penalty(0.16, 0.16, "alcohol")
        assert score == 0.0


# ─── Тесты baseline ──────────────────────────────────────────────

class TestBaseline:
    def _make_history(self, n_events: int, worker: str = "w1") -> list[dict]:
        base_date = datetime(2026, 1, 1)
        return [
            {
                "event_id": f"evt_{i}",
                "worker_pseudonym": worker,
                "timestamp": (base_date + timedelta(days=i*7)).isoformat(),
                "quality_status": "pass",
                "measurements": {
                    "heart_rate": 70 + i * 2,
                    "blood_pressure_systolic": 120 + i,
                },
            }
            for i in range(n_events)
        ]

    def test_baseline_excludes_current_event(self):
        """⚠️ Критический тест: текущая точка не входит в baseline."""
        history = self._make_history(10)
        current_event_id = "evt_5"

        baseline = calculate_baseline(
            worker_pseudonym="w1",
            current_event_id=current_event_id,
            history=history,
        )

        assert baseline["available"] is True
        assert baseline["excluded_event"] == current_event_id

        # Проверка: значение из текущего события не влияет на baseline
        current_hr = 70 + 5 * 2  # = 80
        baseline_mean = baseline["features"]["heart_rate"]["mean"]
        # Без исключения mean было бы другим
        all_values = [70 + i * 2 for i in range(10) if i != 5]
        expected_mean = np.mean(all_values)
        assert abs(baseline_mean - expected_mean) < 0.01

    def test_baseline_insufficient_history(self):
        history = self._make_history(2)
        baseline = calculate_baseline("w1", "evt_0", history)
        assert baseline["available"] is False
        assert baseline["reason"] == "insufficient_history"

    def test_baseline_min_points_per_feature(self):
        history = self._make_history(5)
        # Удаляем heart_rate из двух событий
        for h in history[:2]:
            del h["measurements"]["heart_rate"]

        baseline = calculate_baseline("w1", "evt_4", history)
        assert baseline["features"]["heart_rate"]["available"] is False
        assert baseline["features"]["heart_rate"]["reason"] == "insufficient_points"


# ─── Тесты классификации ─────────────────────────────────────────

class TestStateClassification:
    def test_acute_deviation_detected(self):
        validated = HealthInput(
            event_id="evt_1",
            worker_pseudonym="w1",
            timestamp="2026-09-15T10:00:00+04:00",
            measurements=[
                FeatureInput(name="heart_rate", value=120, unit="bpm",
                            source="measured", confidence=0.95,
                            artifact_pct=1, timestamp="2026-09-15T10:00:00+04:00"),
            ],
        )
        baseline = {
            "available": True,
            "features": {
                "heart_rate": {
                    "available": True,
                    "mean": 72, "std": 5,
                    "corridor_low": 62, "corridor_high": 82,
                }
            },
        }
        config = {"components": {}}

        flags = classify_state(validated, config, baseline, history=None)

        acute = next(f for f in flags if f["flag"] == "acute_deviation")
        assert acute["active"] is True
        assert acute["feature"] == "heart_rate"

    def test_persistent_deviation_counts_unique_dates(self):
        """⚠️ Критический тест: повторные отклонения считаются по уникальным датам."""
        # 3 попытки в один день — не должны считаться как 3 отклонения
        history = [
            {
                "has_acute_deviation": True,
                "timestamp": "2026-09-15T08:00:00+04:00",
            },
            {
                "has_acute_deviation": True,
                "timestamp": "2026-09-15T10:00:00+04:00",
            },
            {
                "has_acute_deviation": True,
                "timestamp": "2026-09-15T12:00:00+04:00",
            },
        ]

        validated = HealthInput(
            event_id="evt_new",
            worker_pseudonym="w1",
            timestamp="2026-09-20T10:00:00+04:00",
            measurements=[],
        )

        flags = classify_state(validated, {"components": {}}, None, history)

        persistent = next(f for f in flags if f["flag"] == "persistent_repeated_deviation")
        assert persistent["active"] is False
        assert persistent["date_count"] == 1  # одна дата, не три

    def test_persistent_deviation_triggered(self):
        history = [
            {"has_acute_deviation": True, "timestamp": "2026-09-10T10:00:00+04:00"},
            {"has_acute_deviation": True, "timestamp": "2026-09-12T10:00:00+04:00"},
            {"has_acute_deviation": True, "timestamp": "2026-09-15T10:00:00+04:00"},
        ]
        validated = HealthInput(
            event_id="evt_new",
            worker_pseudonym="w1",
            timestamp="2026-09-20T10:00:00+04:00",
            measurements=[],
        )
        flags = classify_state(validated, {"components": {}}, None, history)
        persistent = next(f for f in flags if f["flag"] == "persistent_repeated_deviation")
        assert persistent["active"] is True
        assert persistent["date_count"] == 3


# ─── Тесты воспроизводимости ─────────────────────────────────────

class TestReproducibility:
    def test_same_input_same_output(self):
        """Тот же вход + та же версия → идентичный результат."""
        input_data = HealthInput(
            event_id="evt_repro",
            worker_pseudonym="w_repro",
            timestamp="2026-09-15T10:00:00+04:00",
            measurements=[
                FeatureInput(name="heart_rate", value=72, unit="bpm",
                            source="measured", confidence=0.95,
                            artifact_pct=1, timestamp="2026-09-15T10:00:00+04:00"),
                FeatureInput(name="blood_pressure_systolic", value=120, unit="mmHg",
                            source="measured", confidence=0.90,
                            artifact_pct=2, timestamp="2026-09-15T10:00:00+04:00"),
                FeatureInput(name="blood_pressure_diastolic", value=78, unit="mmHg",
                            source="measured", confidence=0.90,
                            artifact_pct=2, timestamp="2026-09-15T10:00:00+04:00"),
                FeatureInput(name="temperature", value=36.6, unit="celsius",
                            source="measured", confidence=0.95,
                            artifact_pct=0, timestamp="2026-09-15T10:00:00+04:00"),
                FeatureInput(name="spo2", value=98, unit="percent",
                            source="measured", confidence=0.95,
                            artifact_pct=0, timestamp="2026-09-15T10:00:00+04:00"),
                FeatureInput(name="alcohol_test", value=0.0, unit="mg/l",
                            source="measured", confidence=1.0,
                            artifact_pct=0, timestamp="2026-09-15T10:00:00+04:00"),
                FeatureInput(name="adequacy_score", value=8, unit="score",
                            source="measured", confidence=0.90,
                            artifact_pct=0, timestamp="2026-09-15T10:00:00+04:00"),
                FeatureInput(name="pupil_reaction", value=9, unit="score",
                            source="measured", confidence=0.90,
                            artifact_pct=0, timestamp="2026-09-15T10:00:00+04:00"),
                FeatureInput(name="examination_regularity", value=0.95, unit="ratio",
                            source="context", confidence=1.0,
                            artifact_pct=0, timestamp="2026-09-15T10:00:00+04:00"),
                FeatureInput(name="missed_examinations", value=0, unit="count",
                            source="context", confidence=1.0,
                            artifact_pct=0, timestamp="2026-09-15T10:00:00+04:00"),
            ],
        )

        result1 = calculate_health_id(input_data, "health_id_v1.0.0")
        result2 = calculate_health_id(input_data, "health_id_v1.0.0")

        assert result1.health_id["value"] == result2.health_id["value"]
        assert result1.audit["config_snapshot_hash"] == result2.audit["config_snapshot_hash"]

    def test_result_contains_disclaimer(self):
        input_data = HealthInput(
            event_id="evt_disc",
            worker_pseudonym="w_disc",
            timestamp="2026-09-15T10:00:00+04:00",
            measurements=[],
        )
        result = calculate_health_id(input_data, "health_id_v1.0.0")
        assert "Не является медицинским диагнозом" in result.health_id.get("disclaimer", "")
```