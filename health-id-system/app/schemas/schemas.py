# backend/schemas.py
from pydantic import BaseModel, Field
from typing import List
from datetime import datetime

class Metric(BaseModel):
    label: str
    value: str

class Component(BaseModel):
    name: str
    value: float
    weight: float

class Details(BaseModel):
    uncertainty: float
    modelVersion: str
    metrics: List[Metric]

class Result(BaseModel):
    id: str
    eventId: str
    workerId: str
    timestamp: datetime
    status: str  # green, yellow, red
    completeness: int
    score: float
    components: List[Component]
    details: Details
