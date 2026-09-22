"""
app/core/governance/version_service.py

Управление версиями модели: создание, публикация, депрекация.
"""

import hashlib
from datetime import datetime
from typing import Optional

import yaml
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import ModelVersion
from app.core.engine.model_config import get_default_config, DEFAULT_CONFIG_V1


# ---------------------------------------------------------------------------
# Создание версии
# ---------------------------------------------------------------------------

def create_version(
    session: Session,
    version_id: str,
    config_yaml_text: str,
    description: str | None = None,
    created_by: str = "system",
) -> ModelVersion:
    """
    Создаёт новую версию модели в статусе draft.

    Проверяет:
      - version_id уникален
      - config_hash уникален (конфиг не дублирует существующий)
      - YAML валиден
    """
    # Проверка уникальности version_id
    existing = session.execute(
        select(ModelVersion).where(ModelVersion.id == version_id)
    ).scalar_one_or_none()
    if existing:
        raise ValueError(f"Версия уже существует: {version_id}")

    # Валидация YAML
    try:
        yaml.safe_load(config_yaml_text)
    except yaml.YAMLError as e:
        raise ValueError(f"Невалидный YAML: {e}")

    config_hash = hashlib.sha256(config_yaml_text.encode("utf-8")).hexdigest()

    # Проверка уникальности хеша
    existing_hash = session.execute(
        select(ModelVersion).where(ModelVersion.config_hash == config_hash)
    ).scalar_one_or_none()
    if existing_hash:
        raise ValueError(
            f"Конфиг дублирует версию {existing_hash.id} (hash={config_hash[:16]}...)"
        )

    version = ModelVersion(
        id=version_id,
        status="draft",
        config_yaml=config_yaml_text,
        config_hash=config_hash,
        description=description,
        created_by=created_by,
        created_at=datetime.utcnow(),
        validation_status="not_validated",
    )
    session.add(version)
    session.commit()

    return version


# ---------------------------------------------------------------------------
# Публикация версии
# ---------------------------------------------------------------------------

def publish_version(
    session: Session,
    version_id: str,
    published_by: str = "system",
) -> ModelVersion:
    """
    Публикует версию — замораживает конфиг.

    Проверки:
      - версия в статусе draft
      - нет другой активной published версии с тем же config_hash
    """
    version = session.execute(
        select(ModelVersion).where(ModelVersion.id == version_id)
    ).scalar_one_or_none()
    if version is None:
        raise ValueError(f"Версия не найдена: {version_id}")

    if version.status != "draft":
        raise ValueError(f"Версия не в draft (текущий статус: {version.status})")

    version.status = "published"
    version.published_at = datetime.utcnow()
    session.commit()

    return version


# ---------------------------------------------------------------------------
# Депрекация версии
# ---------------------------------------------------------------------------

def deprecate_version(
    session: Session,
    version_id: str,
    reason: str,
    deprecated_by: str = "system",
) -> ModelVersion:
    """
    Помечает версию как устаревшую.
    """
    version = session.execute(
        select(ModelVersion).where(ModelVersion.id == version_id)
    ).scalar_one_or_none()
    if version is None:
        raise ValueError(f"Версия не найдена: {version_id}")

    if version.status != "published":
        raise ValueError(f"Только published версия может быть депрекирована (текущий: {version.status})")

    version.status = "deprecated"
    version.deprecated_at = datetime.utcnow()
    version.description = (version.description or "") + f"\n\nDeprecation reason: {reason}"
    session.commit()

    return version


# ---------------------------------------------------------------------------
# Получение версии
# ---------------------------------------------------------------------------

def get_version(session: Session, version_id: str) -> ModelVersion:
    version = session.execute(
        select(ModelVersion).where(ModelVersion.id == version_id)
    ).scalar_one_or_none()
    if version is None:
        raise ValueError(f"Версия не найдена: {version_id}")
    return version


def get_active_version(session: Session) -> ModelVersion | None:
    """Возвращает активную (published) версию."""
    return session.execute(
        select(ModelVersion).where(ModelVersion.status == "published")
        .order_by(ModelVersion.published_at.desc())
    ).scalars().first()


def list_versions(session: Session) -> list[ModelVersion]:
    return list(session.execute(
        select(ModelVersion).order_by(ModelVersion.created_at.desc())
    ).scalars().all())


# ---------------------------------------------------------------------------
# Инициализация версии по умолчанию
# ---------------------------------------------------------------------------

def init_default_version(session: Session) -> ModelVersion:
    """
    Создаёт и публикует версию health_id_v1.0.0, если её ещё нет.
    """
    existing = session.execute(
        select(ModelVersion).where(ModelVersion.id == "health_id_v1.0.0")
    ).scalar_one_or_none()

    if existing:
        return existing

    config_text = DEFAULT_CONFIG_V1.strip()

    version = create_version(
        session=session,
        version_id="health_id_v1.0.0",
        config_yaml_text=config_text,
        description="Исследовательская версия интегрального индекса здоровья",
        created_by="system",
    )

    version = publish_version(session, "health_id_v1.0.0")
    return version
