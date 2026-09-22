# Биометрическая верификация личности — Модуль 4.1.1

## Структура проекта

```
biometric_verification/
├── __init__.py                  # Публичный API
├── cli.py                       # CLI-интерфейс
├── requirements.txt             # Зависимости
├── config/
│   ├── __init__.py
│   └── settings.py              # Конфигурация модели, пороги, хеширование
├── core/
│   ├── __init__.py
│   ├── face_detector.py         # Детекция лица (Haar / MTCNN / MediaPipe)
│   ├── face_embedding.py        # Face embedding (HOG+LBP / dlib / FaceNet)
│   ├── face_matching.py         # Модуль 4.1.1 — Face Matching
│   ├── quality_control.py       # Контроль качества видеопотока
│   ├── routing.py               # Маршрутизация результатов
│   └── verification.py          # Оркестратор верификации
└── db/
    ├── __init__.py
    ├── schema.py                # SQL DDL
    └── connection.py            # Операции с БД
```

## Быстрый старт

### 1. Установка зависимостей

```bash
pip install -r biometric_verification/requirements.txt
```

### 2. Инициализация БД

```bash
python -m biometric_verification.cli init-db \
    --dsn "postgresql://user:pass@localhost:5432/biometric"
```

### 3. Регистрация версии модели

```bash
python -m biometric_verification.cli register-model \
    --dsn "postgresql://user:pass@localhost:5432/biometric" \
    --version face_v1.0.0 \
    --created-by admin
```

### 4. Запуск верификации

```bash
python -m biometric_verification.cli verify \
    --photo photos/user_001.jpg \
    --video videos/user_001.mp4 \
    --worker worker_abc123 \
    --event evt_20260918_001 \
    --dsn "postgresql://user:pass@localhost:5432/biometric"
```

### 5. Проверка качества видео без верификации

```bash
python -m biometric_verification.cli quality-check --video videos/sample.mp4
```

## Программный API

```python
from biometric_verification import BiometricVerifier

verifier = BiometricVerifier()
result = verifier.verify(
    photo_path="photos/user_001.jpg",
    video_path="videos/user_001.mp4",
    worker_pseudonym="worker_abc123",
    event_id="evt_20260918_001",
    db_conn=conn,  # опционально
)

print(result.face_match.match_score)       # float [0, 1]
print(result.face_match.per_frame_scores)   # list[float]
print(result.face_match.best_frame_id)      # int
print(result.face_match.threshold)          # 0.85
print(result.face_match.decision)            # "match" / "no_match" / "insufficient_quality" / "manual_review"
print(result.route)                          # "verified" / "manual_review" / "not_verified"
```

## Пороговые значения (версия face_v1.0.0)

| Параметр | Значение |
|---|---|
| `match_threshold` | 0.85 |
| `manual_review_threshold` | 0.60 |
| `min_detected_frames` | 5 |
| `max_frames_to_analyze` | 30 |

## Бэкенды детекции лица

| Бэкенд | Зависимости | Точность |
|---|---|---|
| Haar cascade | opencv (встроен) | Базовая |
| MTCNN | facenet-pytorch, torch | Высокая |
| MediaPipe | mediapipe | Высокая |

## Бэкенды face embedding

| Метод | Размерность | Зависимости |
|---|---|---|
| HOG+LBP | ~5800 | opencv, numpy |
| dlib ResNet | 128 | dlib |
| FaceNet | 512 | facenet-pytorch, torch |

## Поток данных

```
Фото + Видео
    │
    ▼
┌──────────────┐     ┌──────────────────┐
│ Quality      │────▶│ Face Matching    │
│ Control      │     │ (модуль 4.1.1)   │
└──────────────┘     └────┬─────────────┘
                          │
                          ▼
                   ┌──────────────┐
                   │ Routing      │
                   │ (verif/review/reject) │
                   └──────┬───────┘
                          │
                          ▼
                   ┌──────────────┐
                   │ DB + Audit   │
                   └──────────────┘
```
