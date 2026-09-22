"""
SQLAlchemy-модели для системы HEALTH_ID.

Таблицы:
  - examination_events     — события ПрМО (одна запись = один осмотр)
  - vital_measurements     — витальные показатели (ЧСС, АД, температура, сатурация, алкоголь)
  - mental_assessments     — психофизиологическая оценка (адекватность, речь, зрачки)
  - social_context         — социальный контекст (регулярность, пропуски, условия труда)
  - health_id_results      — результаты расчёта HEALTH_ID
  - media_registry         — реестр медиафайлов (фото/видео из ПАК)

Все идентификаторы работников — псевдонимизированы (hash(SNP_ID)).
"""

from datetime import datetime
from sqlalchemy import (
    Column, String, Integer, Float, DateTime, Boolean, Text,
    ForeignKey, Index, JSON, UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, relationship


class Base(DeclarativeBase):
    pass


# ---------------------------------------------------------------------------
# 1. Событие ПрМО — корневая таблица
# ---------------------------------------------------------------------------

class ExaminationEvent(Base):
    """
    Одно событие периодического медицинского осмотра.

    Связывает витальные показатели, психофизиологию, контекст
    и медиафайлы в единый пакет данных для расчёта HEALTH_ID.
    """
    __tablename__ = "examination_events"

    id = Column(String(36), primary_key=True)          # UUID записи в БД
    event_id = Column(String(64), nullable=False, unique=True, index=True)
    event_type = Column(String(64), nullable=False, default="periodic_medical_examination")
    worker_pseudonym = Column(String(64), nullable=False, index=True)  # hash(SNP_ID)
    timestamp = Column(DateTime, nullable=False, index=True)            # время события

    # Метаданные источника
    mis_source = Column(String(32), nullable=False, default="ECOZ")
    transmission_id = Column(String(64), nullable=True)
    transmission_timestamp = Column(DateTime, nullable=True)

    # Статус обработки
    quality_status = Column(String(32), nullable=False, default="pending")
    # pending | pass | pass_with_warnings | fail

    quality_report = Column(JSON, nullable=True)       # полный отчёт контроля качества
    raw_payload_hash = Column(String(64), nullable=True)  # SHA-256 исходного пакета

    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Связи
    vitals = relationship("VitalMeasurement", back_populates="event", cascade="all, delete-orphan")
    mental = relationship("MentalAssessment", back_populates="event", cascade="all, delete-orphan", uselist=False)
    social = relationship("SocialContext", back_populates="event", cascade="all, delete-orphan", uselist=False)
    health_id_result = relationship("HealthIdResult", back_populates="event", uselist=False)

    __table_args__ = (
        Index("ix_event_worker_ts", "worker_pseudonym", "timestamp"),
    )


# ---------------------------------------------------------------------------
# 2. Витальные показатели — hBody
# ---------------------------------------------------------------------------

class VitalMeasurement(Base):
    """
    Одно измерение витального показателя.

    Один осмотр → несколько записей (ЧСС, АД сист., АД диаст.,
    температура, сатурация, алкоголь).

    Каждая запись хранит:
      - значение и единицу
      - источник (measured / derived / context)
      - метаданные качества (confidence, artifact_pct)
      - информацию о приборе
    """
    __tablename__ = "vital_measurements"

    id = Column(String(36), primary_key=True)
    event_id = Column(String(36), ForeignKey("examination_events.id"), nullable=False, index=True)

    # Идентификация показателя
    feature_name = Column(String(32), nullable=False, index=True)
    # heart_rate | blood_pressure_systolic | blood_pressure_diastolic
    # temperature | spo2 | alcohol_test

    # Значение
    value = Column(Float, nullable=False)
    unit = Column(String(16), nullable=False)
    # bpm | mmHg | °C | % | mg/l

    # Источник данных
    source = Column(String(16), nullable=False, default="measured")
    # measured — измерено прибором/медработником
    # derived — вычислено из других данных
    # context — контекстная информация

    # Метаданные качества
    confidence = Column(Float, nullable=True)          # 0.0–1.0
    artifact_pct = Column(Float, nullable=True)          # процент артефактов
    measurement_protocol = Column(String(32), nullable=True)  # например "standard_v2"

    # Информация о приборе
    device_id = Column(String(64), nullable=True)
    device_model = Column(String(64), nullable=True)

    # Время измерения (может отличаться от времени события)
    measured_at = Column(DateTime, nullable=True)

    # Флаги качества
    unit_mismatch = Column(Boolean, default=False)
    low_quality = Column(Boolean, default=False)
    high_artifact = Column(Boolean, default=False)
    protocol_violation = Column(Boolean, default=False)

    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    # Связи
    event = relationship("ExaminationEvent", back_populates="vitals")

    __table_args__ = (
        Index("ix_vital_event_feature", "event_id", "feature_name"),
        UniqueConstraint("event_id", "feature_name", name="uq_vital_event_feature"),
    )


# ---------------------------------------------------------------------------
# 3. Психофизиологическая оценка — hMental
# ---------------------------------------------------------------------------

class MentalAssessment(Base):
    """
    Психофизиологическая оценка работника.

    Одна запись на событие (не список, как у витальных).
    Содержит оценки: адекватность, связность речи, реакция зрачков.

    Источники:
      - adequacy_score   — оценка медработника (measured)
      - speech_coherence — анализ речи (derived)
      - pupil_reaction   — оценка медработника (measured)
    """
    __tablename__ = "mental_assessments"

    id = Column(String(36), primary_key=True)
    event_id = Column(String(36), ForeignKey("examination_events.id"),
                      nullable=False, unique=True, index=True)

    # Оценка адекватности (медработник, 0–10)
    adequacy_score = Column(Float, nullable=True)
    adequacy_source = Column(String(16), nullable=False, default="measured")
    adequacy_confidence = Column(Float, nullable=True)

    # Связность речи (анализ, 0–10)
    speech_coherence = Column(Float, nullable=True)
    speech_source = Column(String(16), nullable=False, default="derived")
    speech_confidence = Column(Float, nullable=True)

    # Реакция зрачков (медработник, 0–10)
    pupil_reaction = Column(Float, nullable=True)
    pupil_source = Column(String(16), nullable=False, default="measured")
    pupil_confidence = Column(Float, nullable=True)

    # Доп. комментарий медработника
    reviewer_notes = Column(Text, nullable=True)

    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    # Связи
    event = relationship("ExaminationEvent", back_populates="mental")


# ---------------------------------------------------------------------------
# 4. Социальный контекст — hSocial
# ---------------------------------------------------------------------------

class SocialContext(Base):
    """
    Социальный контекст осмотра.

    Одна запись на событие. Содержит:
      - условия труда (workplace, shift)
      - тип осмотра
      - регулярность осмотров (рассчитывается по истории)
      - пропуски осмотров
    """
    __tablename__ = "social_context"

    id = Column(String(36), primary_key=True)
    event_id = Column(String(36), ForeignKey("examination_events.id"),
                      nullable=False, unique=True, index=True)

    # Условия труда
    workplace = Column(String(128), nullable=True)     # например "plant_A"
    shift = Column(String(32), nullable=True)          # morning | evening | night
    examination_type = Column(String(32), nullable=False, default="periodic")
    # periodic | pre_shift | post_shift

    # Регулярность осмотров
    examination_regularity = Column(Float, nullable=True)
    # ratio: actual / expected за окно (0.0–1.0)

    # Пропуски
    missed_examinations = Column(Integer, nullable=True)
    # количество пропущенных осмотров за 30 дней
    missed_window_days = Column(Integer, nullable=True, default=30)

    # Метаданные расчёта
    regularity_calculated_at = Column(DateTime, nullable=True)
    regularity_window_days = Column(Integer, nullable=True, default=90)

    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    # Связи
    event = relationship("ExaminationEvent", back_populates="social")


# ---------------------------------------------------------------------------
# 5. Результат HEALTH_ID
# ---------------------------------------------------------------------------

class HealthIdResult(Base):
    """
    Результат расчёта HEALTH_ID для одного события.

    Хранит:
      - итоговое значение и категорию
      - вклады компонентов
      - метаданные версии модели
      - evidence и аудит
    """
    __tablename__ = "health_id_results"

    id = Column(String(36), primary_key=True)
    event_id = Column(String(36), ForeignKey("examination_events.id"),
                      nullable=False, unique=True, index=True)

    # Итоговое значение
    value = Column(Float, nullable=False)              # 0.0–1.0
    category = Column(String(16), nullable=False)      # green | yellow | red

    # Версия модели
    model_version = Column(String(32), nullable=False, index=True)
    config_snapshot_hash = Column(String(64), nullable=False)

    # Вклады компонентов
    hbody_value = Column(Float, nullable=False)
    hbody_weight = Column(Float, nullable=False)
    hbody_contribution = Column(Float, nullable=False)

    hmental_value = Column(Float, nullable=False)
    hmental_weight = Column(Float, nullable=False)
    hmental_contribution = Column(Float, nullable=False)

    hsocial_value = Column(Float, nullable=False)
    hsocial_weight = Column(Float, nullable=False)
    hsocial_contribution = Column(Float, nullable=False)

    # Полнота и неопределённость
    completeness = Column(Float, nullable=False)       # 0.0–1.0
    uncertainty = Column(Float, nullable=False)        # 0.0–1.0
    missing_features = Column(JSON, nullable=True)      # список отсутствующих

    # Флаги состояния
    acute_deviation = Column(Boolean, default=False)
    persistent_repeated_deviation = Column(Boolean, default=False)
    confirmed_chronic = Column(Boolean, default=False)
    personal_deviation = Column(Boolean, default=False)
    personal_deviation_feature = Column(String(32), nullable=True)
    personal_deviation_detail = Column(JSON, nullable=True)

    # Evidence и аудит
    evidence = Column(JSON, nullable=True)             # полный evidence trace
    human_readable = Column(Text, nullable=True)       # текстовое объяснение

    # Дисклеймер
    disclaimer = Column(Text, nullable=False,
                        default="Исследовательский результат. Не является медицинским диагнозом.")

    # Метаданные расчёта
    calculated_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    calculation_duration_ms = Column(Integer, nullable=True)
    reproducible = Column(Boolean, default=True)

    # Связи
    event = relationship("ExaminationEvent", back_populates="health_id_result")


# ---------------------------------------------------------------------------
# 6. Реестр медиафайлов (из предыдущего шага)
# ---------------------------------------------------------------------------

class MediaRegistry(Base):
    """
    Реестр медиафайлов (фото/видео) из ПАК.
    Связь с событием — через event_uuid (внешний ключ по строке,
    т.к. event_uuid в CSV может быть не-UUID).
    """
    __tablename__ = "media_registry"

    id = Column(String(36), primary_key=True)
    employee_uuid = Column(String(36), nullable=False, index=True)
    event_uuid = Column(String(256), nullable=False, index=True)
    media_type = Column(String(10), nullable=False, index=True)  # photo | video
    relative_path = Column(String(512), nullable=False)
    file_name = Column(String(256), nullable=False)
    size_bytes = Column(Integer, nullable=False)
    sha256_hash = Column(String(64), nullable=True)
    exam_date = Column(DateTime, nullable=False)
    stored_locally = Column(Boolean, default=False)
    last_write_time = Column(DateTime, nullable=False)

    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    __table_args__ = (
        Index("ix_media_employee", "employee_uuid"),
        Index("ix_media_event", "event_uuid"),
        Index("ix_media_type", "media_type"),
    )
# ---------------------------------------------------------------------------
# 7. Human Review — записи проверок медработника
# ---------------------------------------------------------------------------

class ReviewRecord(Base):
    """
    Запись human review — проверка медработником спорного результата.

    Lifecycle:
      pending → confirmed | rejected | escalated

    Типы review:
      verification — спорный результат биометрической верификации
      health_id     — спорный результат расчёта HEALTH_ID
      classification — спорная классификация состояния
    """
    __tablename__ = "review_records"

    id = Column(String(36), primary_key=True)

    # Что проверяется
    review_type = Column(String(32), nullable=False, index=True)
    # verification | health_id | classification

    target_id = Column(String(36), nullable=False, index=True)
    # ID записи, которая проверяется:
    #   verification  → session_id из audit
    #   health_id     → HealthIdResult.id
    #   classification → HealthIdResult.id

    event_id = Column(String(36), ForeignKey("examination_events.id"), nullable=True, index=True)
    worker_pseudonym = Column(String(64), nullable=True, index=True)

    # Статус
    status = Column(String(16), nullable=False, default="pending", index=True)
    # pending | confirmed | rejected | escalated

    # Кто назначил (система)
    assigned_by = Column(String(64), nullable=False, default="system")
    assigned_reason = Column(Text, nullable=True)
    priority = Column(String(16), nullable=False, default="normal")
    # low | normal | high | urgent

    # Кто проверял (медработник)
    reviewer_id = Column(String(64), nullable=True)
    reviewer_name = Column(String(128), nullable=True)
    reviewer_role = Column(String(64), nullable=True)

    # Решение
    decision = Column(String(16), nullable=True)
    # confirmed | rejected | escalated
    decision_comment = Column(Text, nullable=True)
    decision_evidence = Column(JSON, nullable=True)
    decided_at = Column(DateTime, nullable=True)

    # Контекст для медработника (что показывать)
    context = Column(JSON, nullable=True)
    # health_id_value, category, state_flags, evidence_summary,
    # match_score, liveness_score, quality_report, ...

    # Метаданные
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
    expires_at = Column(DateTime, nullable=True)

    __table_args__ = (
        Index("ix_review_type_status", "review_type", "status"),
        Index("ix_review_target", "review_type", "target_id"),
    )

# ---------------------------------------------------------------------------
# 8. Model Governance
# ---------------------------------------------------------------------------

class ModelVersion(Base):
    """
    Журнал версий модели HEALTH_ID.

    Каждая версия — неизменяемая запись. После публикации
    модельная карта замораживается (status: published).
    """
    __tablename__ = "model_versions"

    id = Column(String(64), primary_key=True)          # "health_id_v1.0.0"
    status = Column(String(16), nullable=False, default="draft")
    # draft | published | deprecated | archived

    config_yaml = Column(Text, nullable=False)          # полный YAML конфига
    config_hash = Column(String(64), nullable=False, unique=True)

    description = Column(Text, nullable=True)
    created_by = Column(String(64), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    published_at = Column(DateTime, nullable=True)
    deprecated_at = Column(DateTime, nullable=True)

    # Метрики качества (заполняются после валидации)
    validation_status = Column(String(16), nullable=True)
    # pending | passed | failed | not_validated
    validation_report_path = Column(String(256), nullable=True)
    validation_metrics = Column(JSON, nullable=True)

    # Связи
    drift_records = relationship("DriftRecord", back_populates="model_version")


class DriftRecord(Base):
    """
    Запись об обнаруженном дрейфе данных или модели.

    Типы дрейфа:
      data_drift     — распределение входных данных изменилось
      concept_drift  — связь между входом и результатом изменилась
      prediction_drift — распределение предсказаний изменилось
    """
    __tablename__ = "drift_records"

    id = Column(String(36), primary_key=True)
    model_version_id = Column(String(64), ForeignKey("model_versions.id"), nullable=False, index=True)
    drift_type = Column(String(24), nullable=False, index=True)
    # data_drift | concept_drift | prediction_drift

    feature_name = Column(String(64), nullable=True)
    # null = общий дрейф по всем признакам

    detected_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    window_start = Column(DateTime, nullable=False)
    window_end = Column(DateTime, nullable=False)
    reference_mean = Column(Float, nullable=True)
    reference_std = Column(Float, nullable=True)
    current_mean = Column(Float, nullable=True)
    current_std = Column(Float, nullable=True)

    # Статистика
    test_name = Column(String(64), nullable=True)
    statistic = Column(Float, nullable=True)
    p_value = Column(Float, nullable=True)
    threshold = Column(Float, nullable=True)

    severity = Column(String(16), nullable=False, default="warning")
    # info | warning | critical

    description = Column(Text, nullable=True)
    recommended_action = Column(Text, nullable=True)

    resolved = Column(Boolean, default=False)
    resolved_at = Column(DateTime, nullable=True)
    resolved_by = Column(String(64), nullable=True)

    model_version = relationship("ModelVersion", back_populates="drift_records")


class ValidationReport(Base):
    """
    Отчёт по этапу валидации (R0–R4).

    Хранит метрики, статус и ссылку на файл отчёта.
    """
    __tablename__ = "validation_reports"

    id = Column(String(36), primary_key=True)
    stage = Column(String(8), nullable=False, index=True)
    # R0 | R1 | R2 | R3 | R4

    model_version_id = Column(String(64), ForeignKey("model_versions.id"), nullable=False, index=True)
    status = Column(String(16), nullable=False, default="pending")
    # pending | running | passed | failed

    started_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)

    # Метрики
    metrics = Column(JSON, nullable=True)
    # {accuracy, sensitivity, specificity, ...}

    # Результаты
    summary = Column(Text, nullable=True)
    report_path = Column(String(256), nullable=True)

    # Данные
    n_samples = Column(Integer, nullable=True)
    n_workers = Column(Integer, nullable=True)
    reproducibility_score = Column(Float, nullable=True)

    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)

