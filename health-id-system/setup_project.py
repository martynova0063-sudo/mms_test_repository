"""
setup_project.py

Создаёт полную структуру проекта HEALTH_ID в Replit.
Запуск: python setup_project.py
"""

import os
from pathlib import Path

# ---------------------------------------------------------------------------
# Структура каталогов
# ---------------------------------------------------------------------------

DIRS = [
    "app",
    "app/db",
    "app/api",
    "app/api/routes",
    "app/core",
    "app/core/data",
    "app/core/engine",
    "app/core/classification",
    "app/core/explainability",
    "app/core/review",
    "app/core/governance",
    "app/schemas",
    "scripts",
    "alembic",
    "alembic/versions",
    "tests/unit",
    "tests/integration",
    "tests/security",
    "tests/e2e",
]

# ---------------------------------------------------------------------------
# Файлы (путь → содержимое)
# ---------------------------------------------------------------------------

FILES = {}

# --- .replit ---
FILES[".replit"] = """run = "uvicorn app.main:app --host 0.0.0.0 --port 3000 --reload"
entrypoint = "app/main.py"
hidden = [".config", "venv"]
"""

# --- replit.nix ---
FILES["replit.nix"] = """{ pkgs }: {
  deps = [
    pkgs.python312
    pkgs.python312Packages.fastapi
    pkgs.python312Packages.uvicorn
    pkgs.python312Packages.sqlalchemy
    pkgs.python312Packages.alembic
    pkgs.python312Packages.pydantic
    pkgs.python312Packages.pyyaml
    pkgs.python312Packages.numpy
    pkgs.python312Packages.scipy
    pkgs.python312Packages.httpx
    pkgs.python312Packages.pandas
  ];
}
"""

# --- pyproject.toml ---
FILES["pyproject.toml"] = """[project]
name = "health-id-system"
version = "1.0.0"
description = "Исследовательский интегральный индекс здоровья для ПрМО"
requires-python = ">=3.12"

dependencies = [
    "fastapi>=0.115.0",
    "uvicorn>=0.30.0",
    "sqlalchemy>=2.0.0",
    "alembic>=1.13.0",
    "pydantic>=2.0.0",
    "pyyaml>=6.0",
    "numpy>=1.26.0",
    "scipy>=1.12.0",
    "httpx>=0.27.0",
    "pandas>=2.2.0",
]

[tool.ruff]
line-length = 100
target-version = "py312"
"""

# --- alembic.ini ---
FILES["alembic.ini"] = """[alembic]
script_location = alembic
sqlalchemy.url = sqlite:///health_id.db

[loggers]
keys = root,sqlalchemy,alembic

[handlers]
keys = console

[formatters]
keys = generic

[logger_root]
level = WARN
handlers = console

[logger_sqlalchemy]
level = WARN
handlers =
qualname = sqlalchemy.engine

[logger_alembic]
level = INFO
handlers =
qualname = alembic

[handler_console]
class = StreamHandler
args = (sys.stderr,)
level = NOTSET
formatter = generic

[formatter_generic]
format = %(levelname)-5.5s [%(name)s] %(message)s
datefmt = %H:%M:%S
"""

# --- __init__.py файлы ---
for d in ["app", "app/db", "app/api", "app/api/routes", "app/core",
           "app/core/data", "app/core/engine", "app/core/classification",
           "app/core/explainability", "app/core/review", "app/core/governance",
           "app/schemas", "scripts", "tests"]:
    FILES[f"{d}/__init__.py"] = ""

# --- alembic/env.py ---
FILES["alembic/env.py"] = '''"""Alembic environment."""
from logging.config import fileConfig
from sqlalchemy import engine_from_config, pool
from alembic import context

from app.db.models import Base
from app.config import settings

config = context.config
config.set_main_option("sqlalchemy.url", settings.DATABASE_URL)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline():
    url = config.get_main_option("sqlalchemy.url")
    context.configure(url=url, target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online():
    connectable = engine_from_config(
        config.get_section(config.config_ini_section),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
'''

# --- app/config.py ---
FILES["app/config.py"] = '''"""Конфигурация приложения."""
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite:///health_id.db")
    API_TITLE: str = os.getenv("API_TITLE", "HEALTH_ID System")
    API_VERSION: str = os.getenv("API_VERSION", "v1.0.0")
    MODEL_VERSION: str = os.getenv("MODEL_VERSION", "health_id_v1.0.0")
    DEFAULT_WINDOW_DAYS: int = int(os.getenv("BASELINE_WINDOW_DAYS", "90"))
    MIN_COMPLETENESS: float = float(os.getenv("MIN_COMPLETENESS", "0.70"))


settings = Settings()
'''

# --- app/db/session.py ---
FILES["app/db/session.py"] = '''"""Управление SQLAlchemy-сессиями."""
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session
from contextlib import contextmanager

from app.db.models import Base
from app.config import settings

engine = create_engine(settings.DATABASE_URL, pool_pre_ping=True, echo=False)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


def init_db():
    Base.metadata.create_all(engine)


@contextmanager
def get_session_ctx():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def get_session():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
'''


def write_files():
    """Создаёт каталоги и файлы."""
    root = Path(".")
    
    # Каталоги
    for d in DIRS:
        (root / d).mkdir(parents=True, exist_ok=True)
    
    # __init__.py
    for d in DIRS:
        init_path = root / d / "__init__.py"
        if not init_path.exists():
            init_path.touch()
    
    # Файлы
    for path, content in FILES.items():
        full_path = root / path
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_text(content.strip() + "\n", encoding="utf-8")
        print(f"  ✅ {path}")
    
    print(f"\n  Всего файлов: {len(FILES)}")
    print(f"  Всего каталогов: {len(DIRS)}")


if __name__ == "__main__":
    print("=" * 60)
    print("  Сборка проекта HEALTH_ID")
    print("=" * 60)
    write_files()
    print()
    print("  Структура создана. Теперь:")
    print("  1. pip install fastapi uvicorn sqlalchemy alembic pydantic pyyaml numpy scipy httpx pandas")
    print("  2. alembic upgrade head")
    print("  3. uvicorn app.main:app --host 0.0.0.0 --port 3000 --reload")
    print()
    print("  Или нажмите кнопку Run в Replit.")
