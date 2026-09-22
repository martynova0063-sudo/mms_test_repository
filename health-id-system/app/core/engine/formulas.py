"""
app/core/engine/formulas.py

Математические функции для нормализации и штрафов.

Каждая функция возвращает значение 0.0–1.0:
  1.0 — полное соответствие норме
  0.0 — критическое отклонение
"""

import numpy as np


def normalized_score(value: float, normal_range: tuple[float, float]) -> float:
    """
    Линейная нормализация значения относительно диапазона нормы.

    - Если значение в [low, high] → 1.0
    - Линейное убывание за пределами диапазона

    Скорость убывания: 1 SD от границы = 0.5
    SD оценивается как 15% от ширины диапазона.

    Examples:
        >>> normalized_score(72, (60, 90))
        1.0
        >>> normalized_score(142, (100, 130))
        0.5
        >>> normalized_score(36.6, (36.1, 37.2))
        1.0
    """
    low, high = normal_range
    width = high - low
    sd = max(width * 0.15, 0.01)  # защита от деления на ноль

    if low <= value <= high:
        return 1.0

    if value < low:
        # ниже нормы — линейное убывание
        deviation = low - value
        score = 1.0 - (deviation / (2 * sd))
        return max(0.0, min(1.0, score))

    # value > high — выше нормы
    deviation = value - high
    score = 1.0 - (deviation / (2 * sd))
    return max(0.0, min(1.0, score))


def binary_penalty(value: float, threshold: float = 0.16) -> float:
    """
    Бинарный штраф: если значение ≥ threshold → 0.0, иначе 1.0.

    Используется для alcohol_test:
        0.00 mg/l → 1.0 (норма)
        0.20 mg/l → 0.0 (превышение)

    Examples:
        >>> binary_penalty(0.00, 0.16)
        1.0
        >>> binary_penalty(0.20, 0.16)
        0.0
    """
    return 1.0 if value < threshold else 0.0


def compliance_ratio(actual: float, expected: float = 1.0) -> float:
    """
    Коэффициент соблюдения графика осмотров.

    actual / expected, ограниченный [0, 1].

    Examples:
        >>> compliance_ratio(0.94, 1.0)
        0.94
    """
    if expected <= 0:
        return 1.0
    return max(0.0, min(1.0, actual / expected))


def penalty_function(count: int, window_days: int = 30, max_allowed: int = 2) -> float:
    """
    Штрафная функция для пропущенных осмотров.

    - 0 пропусков → 1.0
    - 1–max_allowed пропусков → линейное убывание
    - > max_allowed → 0.0

    Examples:
        >>> penalty_function(0)
        1.0
        >>> penalty_function(1, max_allowed=2)
        0.67
        >>> penalty_function(5, max_allowed=2)
        0.0
    """
    if count <= 0:
        return 1.0
    if count > max_allowed:
        return 0.0
    return 1.0 - (count / (max_allowed + 1))


# ---------------------------------------------------------------------------
# Диспетчер формул по имени
# ---------------------------------------------------------------------------

FORMULA_REGISTRY = {
    "normalized_score": normalized_score,
    "binary_penalty": binary_penalty,
    "compliance_ratio": compliance_ratio,
    "penalty_function": penalty_function,
}


def apply_formula(formula_name: str, value: float, feature_config) -> float:
    """
    Вызывает нужную формулу по имени, передаёт параметры из конфигурации.

    Args:
        formula_name: имя формулы (из model_card)
        value: значение признака
        feature_config: FeatureConfig с параметрами (normal_range, threshold, …)

    Returns:
        float 0.0–1.0
    """
    func = FORMULA_REGISTRY.get(formula_name)
    if func is None:
        raise ValueError(f"Неизвестная формула: {formula_name}")

    if formula_name == "normalized_score":
        return func(value, feature_config.normal_range)
    elif formula_name == "binary_penalty":
        threshold = feature_config.threshold or 0.16
        return func(value, threshold)
    elif formula_name == "compliance_ratio":
        return func(value, expected=1.0)
    elif formula_name == "penalty_function":
        return func(int(value), max_allowed=2)
    else:
        return func(value)
