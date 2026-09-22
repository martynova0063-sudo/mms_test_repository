"""
app/core/engine/health_id_engine.py

Модуль 2: Движок расчёта HEALTH_ID.

Берёт данные из таблиц БД (examination_events + связанные таблицы),
считает каждый компонент, формирует evidence trace и сохраняет
результат в health_id_results.
"""

import hashlib
import time
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import (
    ExaminationEvent,
    HealthIdResult,
    MentalAssessment,
    SocialContext,
    VitalMeasurement,
)
from app.core.engine.formulas import apply_formula
from app.core.engine.model_config import (
    ComponentConfig,
    FeatureConfig,
    ModelConfig,
    get_default_config,
)


# ---------------------------------------------------------------------------
# Структуры для промежуточных результатов
# ---------------------------------------------------------------------------

class FeatureResult:
    """Результат расчёта одного признака."""
    def __init__(self, name: str, raw_value: float | None, unit: str,
                 source: str, normalized_score: float, normal_range: tuple,
                 contribution_weight: float, contribution: float,
                 quality: dict, available: bool):
        self.name = name
        self.raw_value = raw_value
        self.unit = unit
        self.source = source
        self.normalized_score = normalized_score
        self.normal_range = normal_range
        self.contribution_weight = contribution_weight
        self.contribution = contribution
        self.quality = quality
        self.available = available


class ComponentResult:
    """Результат расчёта одного компонента (hBody / hMental / hSocial)."""
    def __init__(self, name: str, weight: float):
        self.name = name
        self.weight = weight
        self.features: list[FeatureResult] = []
        self.score: float = 0.0
        self.contribution: float = 0.0
        self.available_count: int = 0
        self.total_count: int = 0

    def calculate(self):
        """Считает взвешенный балл компонента."""
        total_weight = sum(f.contribution_weight for f in self.features if f.available)
        if total_weight == 0:
            self.score = 0.0
            return

        weighted_sum = sum(f.contribution for f in self.features if f.available)
        self.score = weighted_sum / total_weight
        self.contribution = self.score * self.weight
        self.available_count = sum(1 for f in self.features if f.available)
        self.total_count = len(self.features)


# ---------------------------------------------------------------------------
# Получение данных из БД
# ---------------------------------------------------------------------------

def _load_vitals(session: Session, event_id: str) -> dict[str, VitalMeasurement]:
    """Загружает витальные показатели для события."""
    rows = session.execute(
        select(VitalMeasurement).where(VitalMeasurement.event_id == event_id)
    ).scalars().all()
    return {r.feature_name: r for r in rows}


def _load_mental(session: Session, event_id: str) -> MentalAssessment | None:
    """Загружает психофизиологическую оценку."""
    return session.execute(
        select(MentalAssessment).where(MentalAssessment.event_id == event_id)
    ).scalar_one_or_none()


def _load_social(session: Session, event_id: str) -> SocialContext | None:
    """Загружает социальный контекст."""
    return session.execute(
        select(SocialContext).where(SocialContext.event_id == event_id)
    ).scalar_one_or_none()


# ---------------------------------------------------------------------------
# Расчёт одного признака
# ---------------------------------------------------------------------------

def _calculate_feature(
    feature_config: FeatureConfig,
    raw_value: float | None,
    quality: dict | None = None,
) -> FeatureResult:
    """
    Рассчитывает один признак:
    1. Применяет формулу нормализации
    2. Считает вклад в компонент
    3. Фиксирует качество
    """
    available = raw_value is not None

    if not available:
        return FeatureResult(
            name=feature_config.name,
            raw_value=None,
            unit=feature_config.unit,
            source=feature_config.source,
            normalized_score=0.0,
            normal_range=feature_config.normal_range,
            contribution_weight=feature_config.contribution_weight,
            contribution=0.0,
            quality=quality or {},
            available=False,
        )

    score = apply_formula(feature_config.formula, raw_value, feature_config)
    contribution = score * feature_config.contribution_weight

    return FeatureResult(
        name=feature_config.name,
        raw_value=raw_value,
        unit=feature_config.unit,
        source=feature_config.source,
        normalized_score=round(score, 4),
        normal_range=feature_config.normal_range,
        contribution_weight=feature_config.contribution_weight,
        contribution=round(contribution, 4),
        quality=quality or {},
        available=True,
    )


# ---------------------------------------------------------------------------
# Расчёт компонента hBody
# ---------------------------------------------------------------------------

def _calculate_hbody(
    config: ModelConfig,
    vitals: dict[str, VitalMeasurement],
) -> ComponentResult:
    """Расчёт компонента hBody — витальные показатели."""
    comp_config = config.components["hBody"]
    result = ComponentResult("hBody", comp_config.weight)

    for feat_cfg in comp_config.features:
        vital = vitals.get(feat_cfg.name)
        raw_value = float(vital.value) if vital else None

        quality = {}
        if vital:
            quality = {
                "confidence": vital.confidence,
                "artifact_pct": vital.artifact_pct,
            }

        feat_result = _calculate_feature(feat_cfg, raw_value, quality)
        result.features.append(feat_result)

    result.calculate()
    return result


# ---------------------------------------------------------------------------
# Расчёт компонента hMental
# ---------------------------------------------------------------------------

def _calculate_hmental(
    config: ModelConfig,
    mental: MentalAssessment | None,
) -> ComponentResult:
    """Расчёт компонента hMental — психофизиологическая оценка."""
    comp_config = config.components["hMental"]
    result = ComponentResult("hMental", comp_config.weight)

    feature_map = {
        "adequacy_score": (mental.adequacy_score if mental else None,
                           mental.adequacy_confidence if mental else None),
        "speech_coherence": (mental.speech_coherence if mental else None,
                             mental.speech_confidence if mental else None),
        "pupil_reaction": (mental.pupil_reaction if mental else None,
                           mental.pupil_confidence if mental else None),
    }

    for feat_cfg in comp_config.features:
        raw_value, conf = feature_map.get(feat_cfg.name, (None, None))
        quality = {"confidence": conf} if conf is not None else {}

        feat_result = _calculate_feature(feat_cfg, raw_value, quality)
        result.features.append(feat_result)

    result.calculate()
    return result


# ---------------------------------------------------------------------------
# Расчёт компонента hSocial
# ---------------------------------------------------------------------------

def _calculate_hsocial(
    config: ModelConfig,
    social: SocialContext | None,
) -> ComponentResult:
    """Расчёт компонента hSocial — социальный контекст."""
    comp_config = config.components["hSocial"]
    result = ComponentResult("hSocial", comp_config.weight)

    for feat_cfg in comp_config.features:
        if feat_cfg.name == "examination_regularity":
            raw_value = social.examination_regularity if social else None
        elif feat_cfg.name == "missed_examinations":
            raw_value = float(social.missed_examinations) if social and social.missed_examinations is not None else None
        else:
            raw_value = None

        feat_result = _calculate_feature(feat_cfg, raw_value, {})
        result.features.append(feat_result)

    result.calculate()
    return result


# ---------------------------------------------------------------------------
# Полнота данных
# ---------------------------------------------------------------------------

def _calculate_completeness(
    components: list[ComponentResult],
    config: ModelConfig,
) -> tuple[float, list[str]]:
    """
    Считает полноту данных: сколько обязательных признаков доступно.

    Returns:
        (completeness_ratio, missing_features)
    """
    total = 0
    available = 0
    missing = []

    for comp in components:
        for feat in comp.features:
            total += 1
            if feat.available:
                available += 1
            else:
                missing.append(feat.name)

    completeness = available / total if total > 0 else 0.0
    return round(completeness, 4), missing


# ---------------------------------------------------------------------------
# Неопределённость
# ---------------------------------------------------------------------------

def _estimate_uncertainty(
    components: list[ComponentResult],
    missing: list[str],
) -> tuple[float, list[dict]]:
    """
    Оценивает неопределённость результата.

    Источники:
      - отсутствующие признаки (каждый — +0.02–0.05)
      - низкое confidence измерений (< 0.8 — +0.01–0.03)
    """
    uncertainty = 0.0
    sources = []

    # 1. Отсутствующие признаки
    for feat_name in missing:
        impact = 0.05 if feat_name in ("speech_coherence", "adequacy_score") else 0.02
        uncertainty += impact
        sources.append({
            "type": "missing_feature",
            "feature": feat_name,
            "impact": round(impact, 2),
        })

    # 2. Низкое confidence
    for comp in components:
        for feat in comp.features:
            if not feat.available:
                continue
            conf = feat.quality.get("confidence")
            if conf is not None and conf < 0.8:
                impact = round(0.03 * (1.0 - conf), 2)
                uncertainty += impact
                sources.append({
                    "type": "measurement_confidence",
                    "feature": feat.name,
                    "impact": impact,
                })

    return round(min(uncertainty, 1.0), 4), sources


# ---------------------------------------------------------------------------
# Категория результата
# ---------------------------------------------------------------------------

def _categorize(value: float, config: ModelConfig) -> str:
    """Определяет категорию (green / yellow / red)."""
    g_low, g_high = config.thresholds["green"]
    y_low, y_high = config.thresholds["yellow"]

    if value >= g_low:
        return "green"
    elif value >= y_low:
        return "yellow"
    else:
        return "red"


# ---------------------------------------------------------------------------
# Evidence trace
# ---------------------------------------------------------------------------

def _build_evidence(
    event: ExaminationEvent,
    config: ModelConfig,
    components: list[ComponentResult],
    completeness: float,
    uncertainty: float,
    missing: list[str],
) -> dict:
    """Формирует полный evidence trace для выходного контракта."""

    # Trace по каждому признаку
    contribution_trace = {}
    formulas_applied = []

    for comp in components:
        comp_trace = {}
        for feat in comp.features:
            if not feat.available:
                comp_trace[feat.name] = {
                    "score": None,
                    "weight": feat.contribution_weight,
                    "product": 0.0,
                    "status": "missing",
                }
                continue

            comp_trace[feat.name] = {
                "score": feat.normalized_score,
                "weight": feat.contribution_weight,
                "product": round(feat.contribution, 4),
                "raw_value": feat.raw_value,
                "normal_range": list(feat.normal_range),
            }

            # Формула для аудита
            if feat.name == "alcohol_test":
                formulas_applied.append(
                    f"binary_penalty({feat.raw_value}, threshold={feat.normal_range[1] + 0.01}) = {feat.normalized_score}"
                )
            else:
                formulas_applied.append(
                    f"normalized_score({feat.raw_value}, {list(feat.normal_range)}) = {feat.normalized_score}"
                )

        contribution_trace[comp.name] = comp_trace

    # Общий результат
    total = sum(c.contribution for c in components)
    contribution_trace["total"] = round(total, 4)

    return {
        "input_ids": [event.event_id],
        "quality_reports": event.quality_report,
        "formulas_applied": formulas_applied,
        "contribution_trace": contribution_trace,
        "model_card_ref": config.model_version,
        "config_hash": config.config_hash,
    }


# ---------------------------------------------------------------------------
# Human-readable explanation
# ---------------------------------------------------------------------------

def _build_human_readable(
    value: float,
    category: str,
    components: list[ComponentResult],
    missing: list[str],
    uncertainty: float,
) -> str:
    """Генерирует текстовое объяснение для медработника."""
    lines = []
    lines.append(f"РЕЗУЛЬТАТ HEALTH_ID: {value:.2f} ({_category_ru(category)})")
    lines.append("")

    comp_names_ru = {
        "hBody": "Физическое состояние",
        "hMental": "Психическое состояние",
        "hSocial": "Социальный контекст",
    }

    feat_names_ru = {
        "heart_rate": "ЧСС",
        "blood_pressure_systolic": "АД сист.",
        "blood_pressure_diastolic": "АД диаст.",
        "temperature": "Температура",
        "spo2": "Сатурация",
        "alcohol_test": "Алкоголь",
        "adequacy_score": "Адекватность",
        "speech_coherence": "Речь",
        "pupil_reaction": "Зрачки",
        "examination_regularity": "Регулярность осмотров",
        "missed_examinations": "Пропуски осмотров",
    }

    for comp in components:
        comp_label = comp_names_ru.get(comp.name, comp.name)
        contribution_pct = (comp.contribution / value * 100) if value > 0 else 0
        lines.append(f"• {comp_label} ({comp.name}): {comp.score:.2f}, вклад {contribution_pct:.0f}%")

        for feat in comp.features:
            feat_label = feat_names_ru.get(feat.name, feat.name)
            if not feat.available:
                lines.append(f"  - {feat_label}: не измерено")
                continue

            if feat.name == "alcohol_test":
                status = "отрицательный" if feat.normalized_score == 1.0 else "положительный ⚠️"
                lines.append(f"  - {feat_label}: {feat.raw_value:.2f} {feat.unit} — {status}")
            elif feat.normalized_score == 1.0:
                lines.append(f"  - {feat_label}: {feat.raw_value} {feat.unit} (норма {feat.normal_range[0]}–{feat.normal_range[1]}) — в норме")
            else:
                arrow = "↑" if feat.raw_value > feat.normal_range[1] else "↓"
                lines.append(f"  - {feat_label}: {feat.raw_value} {feat.unit} (норма {feat.normal_range[0]}–{feat.normal_range[1]}) — отклонение {arrow}")

        lines.append("")

    if missing:
        lines.append(f"ℹ️ Полнота данных: отсутствие: {', '.join(missing)}")
    lines.append(f"ℹ️ Неопределённость: ±{uncertainty:.2f}")
    lines.append("")
    lines.append("📌 Это исследовательский результат, не медицинский диагноз.")

    return "\n".join(lines)


def _category_ru(category: str) -> str:
    return {"green": "зелёная зона", "yellow": "жёлтая зона", "red": "красная зона"}.get(category, category)


# ---------------------------------------------------------------------------
# Главная функция расчёта
# ---------------------------------------------------------------------------

def calculate_health_id(
    event_id: str,
    session: Session,
    config: ModelConfig | None = None,
) -> HealthIdResult:
    """
    Полный пайплайн расчёта HEALTH_ID для одного события.

    1. Загрузка данных из БД
    2. Расчёт компонентов (hBody, hMental, hSocial)
    3. Расчёт итогового индекса
    4. Оценка полноты и неопределённости
    5. Формирование evidence
    6. Сохранение результата в БД

    Args:
        event_id:  event_id из examination_events (НЕ UUID записи)
        session:   SQLAlchemy-сессия
        config:    конфигурация модели (или default v1.0.0)

    Returns:
        HealthIdResult — сохранённая запись
    """
    start_time = time.time()

    if config is None:
        config = get_default_config()

    # --- 1. Загрузка события ---
    event = session.execute(
        select(ExaminationEvent).where(ExaminationEvent.event_id == event_id)
    ).scalar_one_or_none()

    if event is None:
        raise ValueError(f"Событие не найдено: {event_id}")

    if event.quality_status == "fail":
        raise ValueError(f"Событие провалило контроль качества: {event_id}")

    # Проверка: не было ли уже расчёта
    existing_result = session.execute(
        select(HealthIdResult).where(HealthIdResult.event_id == event.id)
    ).scalar_one_or_none()

    if existing_result:
        raise ValueError(f"Расчёт уже существует для события: {event_id}")

    # --- 2. Загрузка данных ---
    vitals = _load_vitals(session, event.id)
    mental = _load_mental(session, event.id)
    social = _load_social(session, event.id)

    # --- 3. Расчёт компонентов ---
    hbody = _calculate_hbody(config, vitals)
    hmental = _calculate_hmental(config, mental)
    hsocial = _calculate_hsocial(config, social)
    components = [hbody, hmental, hsocial]

    # --- 4. Итоговый индекс ---
    health_id_value = sum(c.contribution for c in components)
    health_id_value = round(max(0.0, min(1.0, health_id_value)), 4)

    # --- 5. Категория ---
    category = _categorize(health_id_value, config)

    # --- 6. Полнота и неопределённость ---
    completeness, missing = _calculate_completeness(components, config)
    uncertainty, uncertainty_sources = _estimate_uncertainty(components, missing)

    # Проверка минимальной полноты
    if completeness < config.min_completeness and not config.partial_result:
        raise ValueError(
            f"Полнота данных {completeness} ниже минимума {config.min_completeness}. "
            f"Расчёт невозможен."
        )

    # --- 7. Evidence ---
    evidence = _build_evidence(event, config, components, completeness, uncertainty, missing)

    # --- 8. Human-readable ---
    human_text = _build_human_readable(health_id_value, category, components, missing, uncertainty)

    # --- 9. Сохранение в БД ---
    duration_ms = int((time.time() - start_time) * 1000)

    result = HealthIdResult(
        id=str(uuid.uuid4()),
        event_id=event.id,
        value=health_id_value,
        category=category,
        model_version=config.model_version,
        config_snapshot_hash=config.config_hash,
        hbody_value=hbody.score,
        hbody_weight=hbody.weight,
        hbody_contribution=hbody.contribution,
        hmental_value=hmental.score,
        hmental_weight=hmental.weight,
        hmental_contribution=hmental.contribution,
        hsocial_value=hsocial.score,
        hsocial_weight=hsocial.weight,
        hsocial_contribution=hsocial.contribution,
        completeness=completeness,
        uncertainty=uncertainty,
        missing_features=missing if missing else None,
        acute_deviation=False,
        persistent_repeated_deviation=False,
        confirmed_chronic=False,
        personal_deviation=False,
        evidence=evidence,
        human_readable=human_text,
        disclaimer="Исследовательский результат. Не является медицинским диагнозом.",
        calculated_at=datetime.utcnow(),
        calculation_duration_ms=duration_ms,
        reproducible=True,
    )
    session.add(result)
    session.commit()

    # --- 10. Вывод ---
    _print_summary(result, components, completeness, missing)

    return result


# ---------------------------------------------------------------------------
# Вывод отчёта
# ---------------------------------------------------------------------------

def _print_summary(result: HealthIdResult, components: list[ComponentResult],
                   completeness: float, missing: list[str]):
    print(f"  🧮 HEALTH_ID: {result.value:.2f} ({result.category})")
    print(f"     Модель:    {result.model_version}")
    print(f"     Время:     {result.calculation_duration_ms} ms")
    print()
    for comp in components:
        print(f"     {comp.name}: score={comp.score:.2f}, weight={comp.weight}, "
              f"contribution={comp.contribution:.4f} "
              f"({comp.available_count}/{comp.total_count} признаков)")
    print()
    print(f"     Полнота:   {completeness:.0%}", end="")
    if missing:
        print(f" (отсутствует: {', '.join(missing)})")
    else:
        print()
    print(f"     Неопр.:    ±{result.uncertainty:.2f}")
    print()
    print("     --- Human-readable ---")
    print(result.human_readable)
    print()


# ---------------------------------------------------------------------------
# CLI-запуск для тестирования
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys
    from sqlalchemy import create_engine

    from app.db.models import Base
    from app.core.data.intake import intake_event

    db_url = sys.argv[1] if len(sys.argv) > 1 else "sqlite:///health_id.db"
    engine = create_engine(db_url)
    Base.metadata.create_all(engine)

    # Тестовый пакет
    test_payload = {
        "event_id": "evt_engine_test_001",
        "event_type": "periodic_medical_examination",
        "worker_pseudonym": "hash_worker_001",
        "timestamp": "2026-09-15T10:30:00+04:00",
        "measurements": {
            "vitals": [
                {"name": "heart_rate", "value": 72, "unit": "bpm",
                 "device_id": "d1", "device_model": "ТМ-4",
                 "measurement_protocol": "standard_v2",
                 "confidence": 0.95, "artifact_pct": 2,
                 "timestamp": "2026-09-15T10:29:00+04:00"},
                {"name": "blood_pressure_systolic", "value": 142, "unit": "mmHg",
                 "device_id": "d2", "device_model": "BP-200",
                 "measurement_protocol": "standard_v2",
                 "confidence": 0.92, "artifact_pct": 1,
                 "timestamp": "2026-09-15T10:29:30+04:00"},
                {"name": "blood_pressure_diastolic", "value": 88, "unit": "mmHg",
                 "device_id": "d2", "device_model": "BP-200",
                 "measurement_protocol": "standard_v2",
                 "confidence": 0.92, "artifact_pct": 1,
                 "timestamp": "2026-09-15T10:29:30+04:00"},
                {"name": "temperature", "value": 36.6, "unit": "°C",
                 "device_id": "d3", "device_model": "ThermoPro",
                 "measurement_protocol": "standard_v2",
                 "confidence": 0.98, "artifact_pct": 0,
                 "timestamp": "2026-09-15T10:28:00+04:00"},
                {"name": "spo2", "value": 98, "unit": "%",
                 "device_id": "d4", "device_model": "Oximeter-5",
                 "measurement_protocol": "standard_v2",
                 "confidence": 0.96, "artifact_pct": 0,
                 "timestamp": "2026-09-15T10:28:30+04:00"},
                {"name": "alcohol_test", "value": 0.00, "unit": "mg/l",
                 "device_id": "d5", "device_model": "AlcoPro",
                 "measurement_protocol": "standard_v2",
                 "confidence": 0.99, "artifact_pct": 0,
                 "timestamp": "2026-09-15T10:30:00+04:00"},
            ],
            "mental": [
                {"name": "adequacy_score", "value": 8, "confidence": 0.9,
                 "source": "measured", "timestamp": "2026-09-15T10:30:00+04:00"},
                {"name": "pupil_reaction", "value": 9, "confidence": 0.85,
                 "source": "measured", "timestamp": "2026-09-15T10:30:00+04:00"},
                # speech_coherence отсутствует — тест неполноты
            ],
            "context": {
                "workplace": "plant_A",
                "shift": "morning",
                "examination_type": "periodic",
            },
        },
        "metadata": {
            "mis_source": "ECOZ",
            "transmission_id": "trans_001",
            "transmission_timestamp": "2026-09-15T10:31:00+04:00",
        },
    }

    with Session(engine) as session:
        # 1. Приём данных
        print("=== ШАГ 1: Приём данных ===")
        event = intake_event(test_payload, session)

        # 2. Заполнение social (regularity и missed — заглушка для теста)
        print("=== ШАГ 2: Дополнение social ===")
        social = session.execute(
            select(SocialContext).where(SocialContext.event_id == event.id)
        ).scalar_one()
        social.examination_regularity = 0.94
        social.missed_examinations = 1
        session.commit()
        print(f"  regularity=0.94, missed=1")

        # 3. Расчёт HEALTH_ID
        print()
        print("=== ШАГ 3: Расчёт HEALTH_ID ===")
        result = calculate_health_id("evt_engine_test_001", session)

        print()
        print("=== ПРОВЕРКА ===")
        print(f"  result.value:       {result.value}")
        print(f"  result.category:    {result.category}")
        print(f"  result.completeness: {result.completeness}")
        print(f"  hbody_contribution:  {result.hbody_contribution:.4f}")
        print(f"  hmental_contribution: {result.hmental_contribution:.4f}")
        print(f"  hsocial_contribution: {result.hsocial_contribution:.4f}")
        print(f"  сумма вкладов:      {result.hbody_contribution + result.hmental_contribution + result.hsocial_contribution:.4f}")

        # Проверка: АД сист. 142 — выше нормы (100–130), должно понизить hBody
        assert result.hbody_value < 1.0, "hBody должен быть < 1.0 (АД повышен)"
        # Проверка: speech_coherence отсутствует → неполнота
        assert result.completeness < 1.0, "Полнота должна быть < 100%"
        assert "speech_coherence" in (result.missing_features or []), "speech_coherence должен быть в missing"
        # Проверка: сумма вкладов = итоговое значение
        total = result.hbody_contribution + result.hmental_contribution + result.hsocial_contribution
        assert abs(total - result.value) < 0.01, f"Сумма вкладов {total} ≠ HEALTH_ID {result.value}"

        print()
        print("  ✅ Все проверки пройдены")
