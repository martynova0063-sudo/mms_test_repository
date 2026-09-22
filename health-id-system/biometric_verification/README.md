# Biometric Verification

Биометрическая верификация личности: face matching, liveness, HEALTH_ID, review tasks, drift detection.

## Установка

```bash
pip install -r biometric_verification/requirements.txt
```

## CLI

```bash
python -m biometric_verification.cli verify --photo photos/001.jpg --video videos/001.mp4 --worker w123
python -m biometric_verification.cli liveness-check --video videos/001.mp4
python -m biometric_verification.cli health-id --video videos/001.mp4 --worker w123
python -m biometric_verification.cli init-db --dsn "postgresql://user:pass@localhost/db"
python -m biometric_verification.cli serve --port 8000
```

## API

```bash
uvicorn biometric_verification.api.server:app --port 8000
```

### Endpoints

- `POST /verify` — полная верификация
- `GET /review-tasks?dsn=...&status=pending` — список задач
- `GET /review-tasks/{id}?dsn=...` — детали задачи
- `PUT /review-tasks/{id}?dsn=...` — подтвердить/отклонить
- `POST /drift-analysis?dsn=...` — анализ дрейфа
- `GET /verifications/{id}?dsn=...` — результат верификации
- `POST /init-db` — инициализация БД
- `GET /metrics?dsn=...` — сводные метрики
