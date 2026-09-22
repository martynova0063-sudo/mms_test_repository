# biometric_verification/models/verifications.py
from sqlalchemy import Column, String, Float, DateTime, Text
from sqlalchemy.orm import declarative_base
from datetime import timezone

Base = declarative_base()

class Verification(Base):
    __tablename__ = "verifications"

    verification_id = Column(String, primary_key=True)
    worker_pseudonym = Column(String)
    event_id = Column(String)
    status = Column(String)  # например: "verified", "pending"
    face_match_score = Column(Float)
    liveness_score = Column(Float)
    quality_score = Column(Float)
    pipeline_version = Column(String)
    config_hash = Column(String)
    created_at = Column(DateTime(timezone=True))
    processed_at = Column(DateTime(timezone=True))
    full_result = Column(Text)
