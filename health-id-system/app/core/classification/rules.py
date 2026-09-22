"""
app/core/classification/rules.py

Модуль 5: Правила классификации состояния.

Определения:
  acute_deviation              — острое отклонение: резкий скачок показателя
                                 за пределы нормы или персонального коридора
                                 (≥ 2σ) в текущем событии.

  persistent_repeated_deviation — повторяющееся отклонение: тот же признак
                                 отклоняется ≥ 2 раза за window_days
                                 (default: 30 дней).

  confirmed_chronic            — подтверждённое хроническое: отклонение
                                 persists ≥ 90 дней (≥ 3 событий с отклонением
                                 того же признака за 90 дней).

  personal_deviation            — отклонение от персонального коридора
                                 (baseline), но не от популяционной нормы.
                                 Не является патологией само по себе —
                                 фиксируется для внимания медработника.

Приоритет флагов (если сработали несколько):
  confirmed_chronic > persistent_repeated_deviation > acute_deviation
  personal_deviation — отдельный флаг, может сочетаться с любым из выше.
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

from app.core.data.baseline import DeviationResult
from app.core.engine.model_config import get_default_config


# ---------------------------------------------------------------------------
# Константы порогов
# ---------------------------------------------------------------------------

# Порог острого отклонения: отклонение в сигмах от персонального коридора
ACUTE_SIGMA_THRESHOLD = 2.0

# Порог критического острого отклонения
CRITICAL_SIGMA_THRESHOLD = 3.0

# Окно для повторяющихся отклонений (дни)
PERSISTENT_WINDOW_DAYS = 30

# Минимальное число повторений для persistent
PERSISTENT_MIN_REPEATS = 2

# Окно для хронических отклонений (дни)
CHRONIC_WINDOW_DAYS = 90

# Минимальное число событий с отклонением для chronic
CHRONIC_MIN_EVENTS = 3

# HEALTH_ID ниже этого значения → дополнительный флаг
RED_ZONE_THRESHOLD = 0.60


# ---------------------------------------------------------------------------
# Структуры данных
# ---------------------------------------------------------------------------

@dataclass
class StateFlag:
    """Один флаг состояния."""
    flag: str                   # acute_deviation | persistent_repeated_deviation
                                # | confirmed_chronic | personal_deviation
    active: bool
    feature: str | None = None
    value: float | None = None
    corridor: list[float] | None = None
    deviation_type: str | None = None     # above_corridor | below_corridor
    sigma: float | None = None
    severity: str | None = None          # warning | critical
    details: dict | None = None
    evidence: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = {"flag": self.flag, "active": self.active}
        if self.feature:
            d["feature"] = self.feature
        if self.value is not None:
            d["value"] = self.value
        if self.corridor:
            d["corridor"] = self.corridor
        if self.deviation_type:
            d["deviation_type"] = self.deviation_type
        if self.sigma is not None:
            d["sigma"] = self.sigma
        if self.severity:
            d["severity"] = self.severity
        if self.details:
            d["details"] = self.details
        if self.evidence:
            d["evidence"] = self.evidence
        return d


@dataclass
class ClassificationResult:
    """Полный результат классификации состояния работника."""
    health_id_value: float
    health_id_category: str            # green | yellow | red
    flags: list[StateFlag] = field(default_factory=list)
    dominant_flag: str | None = None   # старший по приоритету активный флаг
    summary: str = ""

    def to_dict(self) -> dict:
        return {
            "health_id_value": self.health_id_value,
            "health_id_category": self.health_id_category,
            "flags": [f.to_dict() for f in self.flags],
            "dominant_flag": self.dominant_flag,
            "summary": self.summary,
        }

    def to_state_flags_list(self) -> list[dict]:
        """Возвращает флаги в формате выходного контракта (раздел 9.1)."""
        return [f.to_dict() for f in self.flags]


# ---------------------------------------------------------------------------
# Приоритеты флагов
# ---------------------------------------------------------------------------

FLAG_PRIORITY = {
    "confirmed_chronic": 3,
    "persistent_repeated_deviation": 2,
    "acute_deviation": 1,
    "personal_deviation": 0,
}


def get_dominant_flag(flags: list[StateFlag]) -> str | None:
    """Возвращает старший по приоритету активный флаг."""
    active = [f for f in flags if f.active]
    if not active:
        return None
    return max(active, key=lambda f: FLAG_PRIORITY.get(f.flag, 0)).flag


# ---------------------------------------------------------------------------
# Правило 1: Острое отклонение (acute_deviation)
# ---------------------------------------------------------------------------

def check_acute_deviation(
    deviations: list[DeviationResult],
    health_id_value: float,
) -> StateFlag:
    """
    Острое отклонение — резкий скачок за пределы нормы.

    Критерии:
      - Признак вышел за персональный коридор на ≥ 2σ
      - ИЛИ HEALTH_ID в красной зоне (< 0.60)
      - ИЛИ признак вышел за популяционную норму (normalized_score < 0.3)

    Severity:
      - critical — если ≥ 3σ ИЛИ HEALTH_ID < 0.60
      - warning  — если 2–3σ
    """
    flag = StateFlag(flag="acute_deviation", active=False)

    evidence = []

    # 1. Проверка отклонений от персонального коридора
    for dev in deviations:
        
        if dev.in_corridor and getattr(dev, "deviation_type", "") not in ("above_norm", "below_norm"):
            continue

        if dev.sigma >= ACUTE_SIGMA_THRESHOLD:
            flag.active = True
            flag.feature = dev.feature_name
            flag.value = dev.current_value
            flag.corridor = [dev.corridor_low, dev.corridor_high]
            flag.deviation_type = dev.deviation_type
            flag.sigma = dev.sigma
            flag.severity = dev.severity

            evidence.append(
                f"{dev.feature_name}: {dev.current_value} vs коридор "
                f"[{dev.corridor_low:.1f}, {dev.corridor_high:.1f}], "
                f"отклонение {dev.sigma:.1f}σ ({dev.deviation_type})"
            )

    # 2. Проверка красной зоны HEALTH_ID
    if health_id_value < RED_ZONE_THRESHOLD:
        flag.active = True
        flag.severity = "critical"
        evidence.append(
            f"HEALTH_ID {health_id_value:.2f} < {RED_ZONE_THRESHOLD} (красная зона)"
        )

    # 3. Если есть critical — повышаем
    if any(d.sigma >= CRITICAL_SIGMA_THRESHOLD for d in deviations if not d.in_corridor):
        flag.severity = "critical"

    if evidence:
        flag.evidence = evidence

    return flag


# ---------------------------------------------------------------------------
# Правило 2: Повторяющееся отклонение (persistent_repeated_deviation)
# ---------------------------------------------------------------------------

@dataclass
class HistoricalDeviation:
    """Запись об отклонении в истории."""
    event_id: str
    timestamp: datetime
    feature_name: str
    value: float
    deviation_type: str          # above_corridor | below_corridor | below_norm | above_norm
    sigma: float


def check_persistent_deviation(
    current_deviations: list[DeviationResult],
    history: list[HistoricalDeviation],
    window_days: int = PERSISTENT_WINDOW_DAYS,
) -> StateFlag:
    """
    Повторяющееся отклонение — тот же признак отклоняется ≥ 2 раза за window_days.

    Логика:
      1. Берём признаки с отклонением в текущем событии
      2. Для каждого считаем, сколько раз он отклонялся в истории за window_days
      3. Если текущее + исторические ≥ PERSISTENT_MIN_REPEATS → persistent

    Args:
        current_deviations: отклонения текущего события (от baseline)
        history:           история отклонений (предварительно собранная)
        window_days:       окно проверки (default: 30)
    """
    flag = StateFlag(flag="persistent_repeated_deviation", active=False)

    now = datetime.utcnow()
    cutoff = now - timedelta(days=window_days)

    # Фильтруем историю по окну
    recent_history = [h for h in history if h.timestamp >= cutoff]

    evidence = []

    for dev in current_deviations:
        if dev.in_corridor and getattr(dev, "deviation_type", "") not in ("above_norm", "below_norm"):
            continue


        # Считаем повторения того же признака с тем же типом отклонения
        repeats = 1  # текущее событие
        matching_events = []

        for h in recent_history:
            if h.feature_name == dev.feature_name and h.deviation_type == dev.deviation_type:
                repeats += 1
                matching_events.append(h)

        if repeats >= PERSISTENT_MIN_REPEATS:
            flag.active = True
            flag.feature = dev.feature_name
            flag.value = dev.current_value
            flag.deviation_type = dev.deviation_type
            flag.sigma = dev.sigma
            flag.severity = "warning"

            evidence.append(
                f"{dev.feature_name}: отклонение {dev.deviation_type} "
                f"{repeats} раза за {window_days} дней "
                f"(события: {[h.event_id for h in matching_events]})"
            )

    if evidence:
        flag.evidence = evidence
        flag.details = {"window_days": window_days, "min_repeats": PERSISTENT_MIN_REPEATS}

    return flag


# ---------------------------------------------------------------------------
# Правило 3: Подтверждённое хроническое (confirmed_chronic)
# ---------------------------------------------------------------------------

def check_confirmed_chronic(
    current_deviations: list[DeviationResult],
    history: list[HistoricalDeviation],
    window_days: int = CHRONIC_WINDOW_DAYS,
) -> StateFlag:
    """
    Подтверждённое хроническое отклонение — отклонение persists ≥ 90 дней.

    Критерии:
      - Тот же признак отклоняется ≥ CHRONIC_MIN_EVENTS раз за CHRONIC_WINDOW_DAYS
      - Отклонения того же типа (above / below)
      - Распределены по времени (не все в один день)

    Дополнительно:
      - Проверяется, что первое и последнее отклонение разделены
        минимум 30 днями (иначе это эпизод, не хроника)
    """
    flag = StateFlag(flag="confirmed_chronic", active=False)

    now = datetime.utcnow()
    cutoff = now - timedelta(days=window_days)

    long_history = [h for h in history if h.timestamp >= cutoff]

    evidence = []

    for dev in current_deviations:
        if dev.in_corridor and getattr(dev, "deviation_type", "") not in ("above_norm", "below_norm"):
            continue


        # События с отклонением того же признака и типа
        matching = [h for h in long_history
                     if h.feature_name == dev.feature_name
                     and h.deviation_type == dev.deviation_type]
        matching.append(HistoricalDeviation(
            event_id="current",
            timestamp=now,
            feature_name=dev.feature_name,
            value=dev.current_value,
            deviation_type=dev.deviation_type,
            sigma=dev.sigma,
        ))

        if len(matching) < CHRONIC_MIN_EVENTS:
            continue

        # Проверка распределения по времени
        timestamps = sorted(h.timestamp for h in matching)
        time_span = (timestamps[-1] - timestamps[0]).days

        if time_span < 30:
            continue

        flag.active = True
        flag.feature = dev.feature_name
        flag.value = dev.current_value
        flag.deviation_type = dev.deviation_type
        flag.sigma = dev.sigma
        flag.severity = "critical"

        evidence.append(
            f"{dev.feature_name}: {len(matching)} отклонений за {time_span} дней "
            f"(от {timestamps[0].date()} до {timestamps[-1].date()})"
        )

    if evidence:
        flag.evidence = evidence
        flag.details = {
            "window_days": window_days,
            "min_events": CHRONIC_MIN_EVENTS,
            "min_time_span_days": 30,
        }

    return flag


# ---------------------------------------------------------------------------
# Правило 4: Персональное отклонение (personal_deviation)
# ---------------------------------------------------------------------------

def check_personal_deviation(
    deviations: list[DeviationResult],
) -> StateFlag:
    """
    Персональное отклонение — выход за персональный коридор.

    Это отдельный флаг, не связанный с популяционной нормой.
    Может сочетаться с acute / persistent / chronic.

    Если отклонение уже классифицировано как acute (≥ 2σ),
    personal_deviation тоже активируется — но с пометкой,
    что это не патология, а индивидуальная особенность.
    """
    flag = StateFlag(flag="personal_deviation", active=False)

    for dev in deviations:
        if dev.in_corridor and getattr(dev, "deviation_type", "") not in ("above_norm", "below_norm"):
            continue


        flag.active = True
        flag.feature = dev.feature_name
        flag.value = dev.current_value
        flag.corridor = [dev.corridor_low, dev.corridor_high]
        flag.deviation_type = dev.deviation_type
        flag.sigma = dev.sigma
        flag.severity = dev.severity
        flag.evidence = [
            f"{dev.feature_name}: {dev.current_value} vs персональный коридор "
            f"[{dev.corridor_low:.1f}, {dev.corridor_high:.1f}]"
        ]
        break  # достаточно первого отклонения

    return flag
