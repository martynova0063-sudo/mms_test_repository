"""Конфигурация приложения."""
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
