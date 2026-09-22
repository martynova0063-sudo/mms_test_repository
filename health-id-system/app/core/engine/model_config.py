"""
app/core/engine/model_config.py

Загрузка и хеширование неизменяемой конфигурации версии модели.
Конфигурация фиксируется в YAML и хешируется (SHA-256)
для прослеживаемости и воспроизводимости.
"""

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


# ---------------------------------------------------------------------------
# Структуры данных конфигурации
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class FeatureConfig:
    """Конфигурация одного признака."""
    name: str
    unit: str
    source: str                    # measured | derived | context
    normal_range: tuple[float, float]
    formula: str                   # имя функции-формулы
    contribution_weight: float
    min_confidence: float | None = None
    max_artifact_pct: float | None = None
    threshold: float | None = None  # для binary_penalty


@dataclass(frozen=True)
class ComponentConfig:
    """Конфигурация одного компонента (hBody / hMental / hSocial)."""
    name: str
    weight: float
    features: list[FeatureConfig]


@dataclass(frozen=True)
class ModelConfig:
    """Полная конфигурация версии модели."""
    model_version: str
    status: str                    # research | validated | deprecated
    description: str
    components: dict[str, ComponentConfig]
    thresholds: dict[str, tuple[float, float]]
    min_completeness: float
    partial_result: bool
    config_hash: str


# ---------------------------------------------------------------------------
# Парсинг YAML-конфига
# ---------------------------------------------------------------------------


def _parse_feature(raw):
    import dataclasses
    import logging

    logger = logging.getLogger(__name__)

    # --- normal_range ---
    nr = raw.get("normal_range")
    if nr is None:
        logger.warning("Фича '%s': нет normal_range, подставлена заглушка [0, 100]",
                       raw.get("name", "?"))
        nr = [0, 100]
    if isinstance(nr, dict):
        nr = [nr.get("min", 0), nr.get("max", 100)]

    # --- critical_range ---
    cr = raw.get("critical_range")
    if cr and isinstance(cr, dict):
        cr = [cr.get("min"), cr.get("max")]

    # --- собираем все возможные поля ---
    all_kwargs = {
        "name": raw["name"],
        "unit": raw.get("unit", ""),
        "source": raw.get("source", "measured"),
        "normal_range": (float(nr[0]), float(nr[1])),
        "critical_range": (float(cr[0]), float(cr[1])) if cr else None,
        "formula": raw.get("formula", "normalized_score"),
        "threshold": float(raw["threshold"]) if "threshold" in raw else None,
        "contribution_weight": float(raw.get("contribution_weight", 0.0)),
        "quality_thresholds": raw.get("quality_thresholds", {}),
    }

    # --- оставляем только валидные поля FeatureConfig ---
    valid = {f.name for f in dataclasses.fields(FeatureConfig)}
    filtered = {k: v for k, v in all_kwargs.items() if k in valid}

    return FeatureConfig(**filtered)

def _parse_component(name: str, raw: dict) -> ComponentConfig:
    """Разбирает описание одного компонента из YAML."""
    return ComponentConfig(
        name=name,
        weight=float(raw["weight"]),
        features=[_parse_feature(f) for f in raw["features"]],
    )


def load_model_config(yaml_path: str | Path) -> ModelConfig:
    """
    Загружает конфигурацию модели из YAML-файла.

    Вычисляет SHA-256 от содержимого файла — это и есть
    config_snapshot_hash, который сохраняется в каждом результате.
    """
    path = Path(yaml_path)
    raw_text = path.read_text(encoding="utf-8")
    raw_yaml = yaml.safe_load(raw_text)

    config_hash = hashlib.sha256(raw_text.encode("utf-8")).hexdigest()

    components = {}
    for comp_name, comp_raw in raw_yaml.get("components", {}).items():
        components[comp_name] = _parse_component(comp_name, comp_raw)

    thresholds_raw = raw_yaml.get("thresholds", {})
    thresholds = {
        "green": (float(thresholds_raw["green"][0]), float(thresholds_raw["green"][1])),
        "yellow": (float(thresholds_raw["yellow"][0]), float(thresholds_raw["yellow"][1])),
        "red": (float(thresholds_raw["red"][0]), float(thresholds_raw["red"][1])),
    }

    uncertainty = raw_yaml.get("uncertainty", {})

    return ModelConfig(
        model_version=raw_yaml["model_version"],
        status=raw_yaml["status"],
        description=raw_yaml.get("description", ""),
        components=components,
        thresholds=thresholds,
        min_completeness=float(uncertainty.get("min_completeness", 0.70)),
        partial_result=bool(uncertainty.get("partial_result", True)),
        config_hash=config_hash,
    )


# ---------------------------------------------------------------------------
# Конфигурация по умолчанию (v1.0.0) — встроенная, если YAML недоступен
# ---------------------------------------------------------------------------

DEFAULT_CONFIG_V1 = """
model_version: "health_id_v1.0.0"
status: "research"
description: "Исследовательская версия интегрального индекса здоровья"

components:
  hBody:
    weight: 0.60
    features:
      - name: "heart_rate"
        unit: "bpm"
        source: "measured"
        normal_range: [60, 90]
        quality_thresholds:
          min_confidence: 0.8
          max_artifact_pct: 5
        formula: "normalized_score"
        contribution_weight: 0.25
        normal_range:  # ✅ Обязательно добавьте это
          min: 60
          max: 90
        critical_range:
          min: 40
          max: 120

      - name: "blood_pressure_systolic"
        unit: "mmHg"
        source: "measured"
        normal_range: [100, 130]
        formula: "normalized_score"
        contribution_weight: 0.25

      - name: "blood_pressure_diastolic"
        unit: "mmHg"
        source: "measured"
        normal_range: [60, 85]
        formula: "normalized_score"
        contribution_weight: 0.20

      - name: "temperature"
        unit: "°C"
        source: "measured"
        normal_range: [36.1, 37.2]
        formula: "normalized_score"
        contribution_weight: 0.15
        normal_range:  # ✅ И это тоже
          min: 36.0
          max: 37.5
        critical_range:
          min: 35.0
          max: 39.0

      - name: "spo2"
        unit: "%"
        source: "measured"
        normal_range: [95, 100]
        formula: "normalized_score"
        contribution_weight: 0.10

      - name: "alcohol_test"
        unit: "mg/l"
        source: "measured"
        normal_range: [0, 0.15]
        formula: "binary_penalty"
        threshold: 0.16
        contribution_weight: 0.05

  hMental:
    weight: 0.25
    features:
      - name: "adequacy_score"
        unit: "0-10"
        source: "measured"
        normal_range: [7, 10]
        formula: "normalized_score"
        contribution_weight: 0.40

      - name: "speech_coherence"
        unit: "0-10"
        source: "derived"
        normal_range: [7, 10]
        formula: "normalized_score"
        contribution_weight: 0.35

      - name: "pupil_reaction"
        unit: "0-10"
        source: "measured"
        normal_range: [7, 10]
        formula: "normalized_score"
        contribution_weight: 0.25

  hSocial:
    weight: 0.15
    features:
      - name: "examination_regularity"
        unit: "ratio"
        source: "context"
        normal_range:
          min: 0.8
          max: 1.0
        formula: "compliance_ratio"
        contribution_weight: 0.50

      - name: "missed_examinations"
        unit: "count"
        source: "context"
        normal_range:
          min: 0
          max: 2
        formula: "penalty_function"
        contribution_weight: 0.50

thresholds:
  green: [0.80, 1.00]
  yellow: [0.60, 0.80]
  red: [0.00, 0.60]

uncertainty:
  min_completeness: 0.70
  partial_result: true
"""


def get_default_config() -> ModelConfig:
    """Возвращает встроенную конфигурацию v1.0.0."""
    raw_text = DEFAULT_CONFIG_V1.strip()
    raw_yaml = yaml.safe_load(raw_text)
    config_hash = hashlib.sha256(raw_text.encode("utf-8")).hexdigest()

    components = {}
    for comp_name, comp_raw in raw_yaml["components"].items():
        components[comp_name] = _parse_component(comp_name, comp_raw)

    thresholds_raw = raw_yaml["thresholds"]
    thresholds = {
        "green": (float(thresholds_raw["green"][0]), float(thresholds_raw["green"][1])),
        "yellow": (float(thresholds_raw["yellow"][0]), float(thresholds_raw["yellow"][1])),
        "red": (float(thresholds_raw["red"][0]), float(thresholds_raw["red"][1])),
    }

    uncertainty = raw_yaml.get("uncertainty", {})

    return ModelConfig(
        model_version=raw_yaml["model_version"],
        status=raw_yaml["status"],
        description=raw_yaml.get("description", ""),
        components=components,
        thresholds=thresholds,
        min_completeness=float(uncertainty.get("min_completeness", 0.70)),
        partial_result=bool(uncertainty.get("partial_result", True)),
        config_hash=config_hash,
    )
