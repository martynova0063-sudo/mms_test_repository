"""Управление SQLAlchemy-сессиями."""
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
