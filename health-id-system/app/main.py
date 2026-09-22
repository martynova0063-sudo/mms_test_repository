"""
app/main.py

FastAPI entry point.

Запуск:
    uvicorn app.main:app --host 0.0.0.0 --port 3000 --reload
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.db.session import init_db
from app.api.routes.calculate import router as calculate_router
from app.api.routes.review import router as review_router
from app.api.routes.governance import router as governance_router

from fastapi import APIRouter
from app.schemas.schemas import Result

router = APIRouter()

# В реальности данные берутся из БД, здесь — заглушка
MOCK_RESULTS = [
    {
        "id": "res_88b4b361",
        "eventId": "evt_20260915_001",
        "workerId": "wrk_7d2c",
        "timestamp": "2026-09-15T09:18:00",
        "status": "green",
        "completeness": 100,
        "score": 1.00,
        "components": [
            {"name": "Физическое состояние", "value": 1.00, "weight": 0.60},
            {"name": "Психофизиологическая оценка", "value": 1.00, "weight": 0.25},
            {"name": "Контекст осмотров", "value": 1.00, "weight": 0.15},
        ],
        "details": {
            "uncertainty": 0.03,
            "modelVersion": "health_id_v1.0.0",
            "metrics": [
                {"label": "ЧСС", "value": "72 уд/мин"},
                {"label": "АД систолическое", "value": "128 мм рт. ст."},
                {"label": "АД диастолическое", "value": "78 мм рт. ст."},
                {"label": "Температура", "value": "36.6 °C"},
                {"label": "Сатурация", "value": "98%"},
                {"label": "Алкогольный тест", "value": "0 мг/л"},
            ],
        },
    },
    # добавьте остальные элементы как в mockResults из React-кода
]

@router.get("/api/health-id/results", response_model=list[Result])
async def get_results():
    return MOCK_RESULTS

app = FastAPI(
    title=settings.API_TITLE,
    version=settings.API_VERSION,
    description=(
        "Исследовательский интегральный индекс здоровья для "
        "периодических медицинских осмотров. Не является медицинским изделием."
    ),
)

origins = [
    "http://localhost:5173",  # Vite
    "http://localhost:3000",  # Create React App
]

# CORS для Replit
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Роуты
app.include_router(calculate_router)
# ... после app.include_router(calculate_router)
app.include_router(review_router)
# ... после review_router
app.include_router(governance_router)

app.include_router(router)

@app.on_event("startup")
def startup():
    """Инициализация БД при запуске."""
    init_db()
        # Инициализация версии по умолчанию
    from app.db.session import SessionLocal
    from app.core.governance.version_service import init_default_version
    with SessionLocal() as session:
        init_default_version(session)



@app.get("/")
def root():
    return {
        "system": "HEALTH_ID",
        "version": settings.API_VERSION,
        "model_version": settings.MODEL_VERSION,
        "status": "research",
        "disclaimer": "Не является медицинским изделием. Только для исследовательских целей.",
        "docs": "/docs",
    }


@app.get("/health")
def health():
    return {"status": "ok"}


