# 🏢 Техническое задание на разработку исследовательского модуля биометрической верификации личности и расчёта индекса HEALTH_ID для системы дистанционных периодических медицинских осмотров

---
## 📑 Содержание

- [📋 1. Общие сведения](#1-общие-сведения)
  - [1.1. Наименование проекта](#11-наименование-проекта)
  - [1.2. Платформа разработки](#12-платформа-разработки)
  - [1.3. Назначение и область применения](#13-назначение-и-область-применения)
  - [1.4. Регуляторный контекст](#14-регуляторный-контекст)
  - [1.5. Исходные данные](#15-исходные-данные)
- [🏗 2. Архитектура системы](#2-архитектура-системы)
  - [2.1. Принцип разделения контуров](#21-принцип-разделения-контуров)
  - [2.2. Структура модулей](#22-структура-модулей)
  - [2.3. Технологический стек](#23-технологический-стек)
- [📚 3. Функциональные требования](#3-функциональные-требования)
  - [3.1. Модуль биометрической верификации](#31-модуль-биометрической-верификации)
    - [3.1.1. Сравнение лица с эталонной фотографией (face_match)](#311-сравнение-лица-с-эталонной-фотографией-face_match)
    - [3.1.2. Liveness detection](#312-liveness-detection)
    - [3.1.3. Контроль качества видео (video_quality)](#313-контроль-качества-видео-video_quality)
    - [3.1.4. Маршрутизация результатов (router)](#314-маршрутизация-результатов-router)
  - [3.2. Модуль приёма и контроля качества входных данных из МИС ЕЦОЗ](#32-модуль-приёма-и-контроля-качества-входных-данных-из-мис-ецоз)
    - [3.2.1. 📥 Источники данных](#321-источники-данных)
    - [3.2.2. ✅ Контроли качества входных данных](#322-контроли-качества-входных-данных)
    - [3.2.3. 📄 Структура отчёта о качестве](#323-структура-отчёта-о-качестве)
  - [3.3. 🧮 Версионированный движок расчёта HEALTH_ID](#33-версионированный-движок-расчёта-health_id)
    - [3.3.1. 📐 Формула индекса (исследовательская версия)](#331-формула-индекса-исследовательская-версия)
    - [3.3.2. 🏷️ Версионирование модели](#332-версионирование-модели)
    - [3.3.3. 📈 Расчёт персональных коридоров (baseline)](#333-расчёт-персональных-коридоров-baseline)
    - [3.3.4. 🚦 Классификация состояния](#334-классификация-состояния)
  - [3.4. 📤 Выходной контракт расчёта HEALTH_ID](#34-выходной-контракт-расчёта-health_id)
  - [3.5. 🩺 Модуль клинической проверки (human review)](#35-модуль-клинической-проверки-human-review)
    - [3.5.1. 🔄 Workflow](#351-workflow)
    - [3.5.2. 📋 Структуры данных](#352-структуры-данных)
    - [3.5.3. 🖥️ Интерфейс медработника](#353-интерфейс-медработника)
  - [3.6. 🏛️ Подсистема model governance](#36-подсистема-model-governance)
    - [3.6.1. 📇 Model card](#361-model-card)
    - [3.6.2. 📓 Журнал версий](#362-журнал-версий)
    - [3.6.3. 🧪 Валидационные тесты](#363-валидационные-тесты)
    - [3.6.4. 📉 Отслеживание дрейфа данных](#364-отслеживание-дрейфа-данных)
  - [3.7. 🔌 API](#37-api)
    - [3.7.1. 🌐 Эндпоинты](#371-эндпоинты)
    - [3.7.2. 🔐 Аутентификация и авторизация](#372-аутентификация-и-авторизация)
    - [3.7.3. ⏱️ Ограничения API](#373-ограничения-api)
- [4. 🗄️ Требования к данным](#4-требования-к-данным)
  - [4.1. Схема базы данных (основные таблицы)](#41-схема-базы-данных-основные-таблицы)
  - [4.2. 🕵️ Обезличивание данных](#42-обезличивание-данных)
- [5. 🛡️ Требования безопасности](#5-требования-безопасности)
  - [5.1. 📜 Соответствие 152-ФЗ (персональные данные)](#51-соответствие-152-фз-персональные-данные)
  - [5.2. 🏥 Разделение контуров](#52-разделение-контуров)
  - [5.3. 🔧 Технические меры](#53-технические-меры)
  - [5.4. 👩‍⚕️ Требования к медицинскому работнику](#54-требования-к-медицинскому-работнику)
- [6. 🧪 Протоколы валидации R0–R4](#6-протоколы-валидации-r0r4)
- [7. ⚙️ Нефункциональные требования](#7-нефункциональные-требования)
- [8. 📁 Структура проекта в Replit](#8-структура-проекта-в-replit)
- [9. 🗓️ Этапы и сроки реализации](#9-этапы-и-сроки-реализации)
- [10. ✅ Критерии приёмки](#10-критерии-приёмки)
- [🏁 Конец ТЗ](#конец-тз)

---


## 📋 1. Общие сведения

### 1.1. Наименование проекта

Исследовательский модуль компьютерного зрения для подтверждения личности работника при дистанционном прохождении периодических медицинских осмотров (ПрМО) с интегрированным версионированным движком расчёта интегрального индекса здоровья HEALTH_ID.

### 1.2. Платформа разработки

Replit — облачная IDE с поддержкой Python (FastAPI/Django), PostgreSQL, Redis. Развёртывание в контейнерной среде Replit с возможностью последующей миграции в защищённый контур организации.

### 1.3. Назначение и область применения

Система предназначена **исключительно для исследовательских целей** до завершения всех этапов клинической валидации R0–R4. Модуль обеспечивает:

- проверку соответствия лица на видео эталонной фотографии работника;
- подтверждение присутствия живого человека (liveness detection);
- контроль качества входящего видеосигнала;
- маршрутизацию результатов верификации (`verified`, `manual_review`, `not_verified`);
- расчёт интегрального индекса здоровья HEALTH_ID с полным аудитом и объяснимостью;
- клиническую проверку результатов медицинским работником (human review).

При спорных результатах биометрической верификации выполняется ручная идентификация медицинским работником. **Факт несовпадения личности не является медицинским недопуском** — решение о допуске принимает медицинский работник на основании клинических данных.

### 1.4. Регуляторный контекст

Проект должен соответствовать требованиям следующих нормативных актов:

- **Федеральный закон № 323‑ФЗ** от 21.11.2011 «Об основах охраны здоровья граждан» (ст. 36.2 — телемедицинские технологии, ст. 46 — медицинские осмотры);
- **Федеральный закон № 152‑ФЗ** от 27.07.2006 «О персональных данных» (ст. 9 — согласие, ст. 11 — биометрические ПДн);
- **Федеральный закон № 572‑ФЗ** от 29.12.2022 — идентификация физических лиц с использованием биометрических ПДн;
- **Постановление Правительства РФ № 866** от 30.05.2023 — требования к проведению дистанционных медосмотров, идентификация личности через ЕСИА или ЕБС;
- **Приказ Минздрава РФ № 193н** от 11.04.2025 — порядок организации телемедицинской помощи;
- **Приказ Минздрава РФ № 266н** от 30.05.2023 — порядок проведения предсменных, предрейсовых и иных медосмотров;
- **Рекомендации Росздравнадзора** по дистанционным медосмотрам и контролю качества медицинской помощи;
- **Разъяснения Роскомнадзора** по отнесению фото- и видеоизображений к биометрическим персональным данным.

### 1.5. Исходные данные

Организация располагает обезличенным набором данных ПрМО:
- **2 967 событий** за период 2025–2026 годов;
- **23 работника**;
- формат: события ПрМО, витальные показатели, контекстные данные.

Набор используется для пилотного исследования интегрального индекса HEALTH_ID.

---

## 🏗 2. Архитектура системы

### 2.1. Принцип разделения контуров

Система должна реализовать **строгое разделение медицинского и корпоративного контуров**:

| Параметр | Медицинский контур | Корпоративный контур |
| --- | --- | --- |
| Назначение | Верификация личности, расчёт `HEALTH_ID`, клиническая оценка | Учёт прохождения медосмотров, формирование отчётности для работодателя |
| Данные | Биометрия, витальные показатели, индекс `HEALTH_ID`, `ЭМК` | Факт прохождения/непрохождения, медицинское заключение (допуск/недопуск) |
| Доступ | Медицинские работники, клинические исследователи | HR, руководство организации (только агрегированные результаты) |
| Хранение | Изолированная БД, шифрование at-rest | Отдельная БД, передача только по защищённому каналу |
| API | Внутренний API медицинского контура | API с минимизированным набором полей |

Передача данных между контурами — только через **шлюз маршрутизации** с маскированием персональных идентификаторов и логированием каждого запроса.

### 2.2. Структура модулей
```text
health_id_system/
├── config/ # Конфигурации версий модели, порогов, норм
├── core/
│ ├── biometric/ # Модуль биометрической верификации
│ │ ├── face_match.py # Сравнение лица с эталоном
│ │ ├── liveness.py # Liveness detection
│ │ ├── video_quality.py # Контроль качества видео
│ │ └── router.py # Маршрутизация результатов
│ ├── data_intake/ # Модуль приёма данных из МИС ЕЦОЗ
│ │ ├── validator.py # Валидация входных данных
│ │ ├── quality_check.py # Контроль качества сигнала
│ │ └── provenance.py # Проверка происхождения данных
│ ├── engine/ # Версионированный движок HEALTH_ID
│ │ ├── calculator.py # Расчёт индекса
│ │ ├── baseline.py # Персональные коридоры
│ │ ├── classifier.py # Классификация состояния
│ │ └── version_manager.py # Управление версиями
│ ├── review/ # Модуль клинической проверки
│ │ ├── human_review.py # Human review workflow
│ │ └── audit.py # Аудит решений
│ └── governance/ # Model governance
│ ├── model_card.py # Model card
│ ├── version_log.py # Журнал версий
│ ├── tests.py # Валидационные тесты
│ └── drift_monitor.py # Отслеживание дрейфа
├── api/ # REST API
│ ├── routes/ # Эндпоинты
│ └── contracts/ # Контракты данных
├── db/ # Схема БД, миграции
├── tests/ # Тесты (unit, integration, e2e)
├── docs/ # Документация, протоколы валидации
└── validation/ # Этапы валидации R0–R4
```

### 2.3. Технологический стек

| Компонент | Технология |
| --- | --- |
| Язык | Python 3.11+ |
| Web‑фреймворк | FastAPI + Uvicorn |
| БД | PostgreSQL 15+ (основная), Redis (кэш, очереди) |
| Очереди задач | Celery или ARQ (async) |
| Компьютерное зрение | OpenCV, face_recognition, MediaPipe |
| Машинное обучение | scikit-learn, NumPy, SciPy |
| Хранение файлов | S3‑совместимое (MinIO для research) |
| Аутентификация | OAuth2 + JWT, интеграция с ЕСИА |
| ЭЦП | КриптоПро (для подписи медицинских заключений) |
| Логирование | Structured logging (structlog), ELK‑совместимый формат |

---

## 📚 3. Функциональные требования

### 3.1. Модуль биометрической верификации

#### 3.1.1. Сравнение лица с эталонной фотографией (face_match)

**Входные данные:**
- Видеопоток или видеофайл с веб‑камеры работника (минимум 3 секунды, 30 fps);
- Эталонная фотография работника из кадровой системы (получается при первичной идентификации через ЕСИА или ЕБС).

**Алгоритм:**
1. Извлечение кадров из видеопотока (не менее 5 кадров с интервалом).
2. Детекция лица на каждом кадре (Haar cascade, MTCNN или MediaPipe Face Detection).
3. Вычисление векторного представления лица (face embedding) для каждого кадра с detected лицом.
4. Сравнение с векторным представлением эталонной фотографии (косинусное сходство).
5. Усреднение результатов по кадрам для устойчивости.

**Выходные данные:**
- `match_score`: float [0, 1] — итоговая оценка сходства;
- `per_frame_scores`: list[float] — оценки по кадрам;
- `best_frame_id`: int — идентификатор кадра с максимальной оценкой;
- `threshold`: float — использованный порог (из конфигурации версии модели);
- `decision`: enum — `match` / `no_match` / `insufficient_quality`.

**Пороговые значения** (версионируются, хранятся в config):
- `match` — `match_score >= 0.85`;
- `manual_review` — `0.60 <= match_score < 0.85`;
- `no_match` — `match_score < 0.60`.

#### 3.1.2. Liveness detection

**Методы (комбинированный подход):**
1. **Eye blink detection** — анализ движения век между кадрами (оптический поток в зоне глаз).
2. **Head movement challenge** — реакция на инструкцию повернуть голову (если реализован интерактивный режим).
3. **Texture analysis** — анализ текстурных признаков (LBP, частотный анализ) для выявления фотоподстановки с экрана.
4. **Depth estimation** — при наличии стереокамеры или ToF‑сенсора (опционально, для будущих версий).

**Выходные данные:**
- `liveness_score`: float [0, 1];
- `liveness_signals`: dict — результаты по каждому методу;
- `decision`: enum — `live` / `spoof_detected` / `inconclusive`;
- `evidence_frames`: list[int] — идентификаторы кадров с аномалиями (при обнаружении spoof).

#### 3.1.3. Контроль качества видео (video_quality)

**Проверяемые параметры:**

| Параметр | Порог | Действие при нарушении |
| --- | --- | --- |
| Разрешение | не менее 640×480 | `reject` |
| Частота кадров | не менее 15 fps | `reject` |
| Длительность | не менее 3 секунд | `reject` |
| Освещённость | уровень яркости в допустимом диапазоне | `warning` |
| Контрастность | коэффициент контраста > 0.3 | `warning` |
| Размытие | variance of Laplacian > 100 | `warning` |
| Наличие лица | минимум 1 лицо на 80 % кадров | `reject` |
| Позиция лица | фронтальное или почти фронтальное (yaw < 30°) | `warning` |

**Выходные данные:**
- `quality_metrics`: dict — значения всех параметров;
- `quality_score`: float [0, 1] — сводная оценка качества;
- `decision`: enum — `accept` / `degraded` / `reject`;
- `issues`: list[str] — описания выявленных проблем.

#### 3.1.4. Маршрутизация результатов (router)

Комбинированная логика маршрутизации на основе результатов трёх подмодулей:

| face_match | liveness | quality | Итоговый статус |
| --- | --- | --- | --- |
| match | live | accept | `verified` |
| match | live | degraded | `verified` (с пометкой о качестве) |
| match | spoof_detected | * | `not_verified` |
| no_match | * | * | `not_verified` |
| manual_review | live | accept/degraded | `manual_review` |
| match | inconclusive | * | `manual_review` |
| * | * | reject | `not_verified` (повторный запрос видео) |

**Структура результата верификации:**

```json
{
  "verification_id": "uuid",
  "worker_pseudonym": "SHA-256 hash",
  "timestamp": "ISO-8601",
  "status": "verified | manual_review | not_verified",
  "face_match": {
    "score": 0.92,
    "threshold": 0.85,
    "decision": "match",
    "per_frame_scores": [0.89, 0.93, 0.91, 0.94, 0.92],
    "model_version": "face_v1.2.0"
  },
  "liveness": {
    "score": 0.95,
    "decision": "live",
    "signals": {
      "eye_blink": true,
      "texture": "natural",
      "depth": null
    },
    "model_version": "liveness_v1.0.1"
  },
  "quality": {
    "score": 0.88,
    "decision": "accept",
    "metrics": { "resolution": "640x480", "fps": 30, "blur": 125.3 },
    "issues": []
  },
  "audit": {
    "pipeline_version": "verify_v1.1.0",
    "config_hash": "SHA-256 of config",
    "processing_time_ms": 3420,
    "frames_processed": 90,
    "frames_with_face": 87
  }
}
```

**Хранение биометрических данных:**

- Векторные представления (embeddings) хранятся в зашифрованном виде.
- Исходные видеокадры не сохраняются после расчёта (только метаданные и хеши).
- Эталонные фотографии хранятся в изолированном хранилище с доступом только через API.
- Срок хранения embeddings — до отзыва согласия субъекта или прекращения исследования.
- Требуется письменное согласие субъекта на обработку биометрических ПДн в соответствии со ст. 11 ФЗ‑152.

### 3.2. Модуль приёма и контроля качества входных данных из МИС ЕЦОЗ

#### 3.2.1. 📥 Источники данных
Данные поступают из медицинской информационной системы Единого цифрового медицинского обслуживания (МИС ЕЦОЗ) через стандартизированный API (REST/FHIR или внутренний формат ЕГИСЗ).

**Типы данных:**

- 🏥 События ПрМО — дата/время, тип осмотра, идентификатор работника;
- ❤️ Витальные показатели — ЧСС, АД, температура, сатурация, сахар крови, алкотест и др.;
- 📋 Контекстные данные — протокол измерения, тип прибора, сведения о поверке.

#### 3.2.2. ✅ Контроли качества входных данных
Контроль	Описание	Действие при нарушении
- 🔐 Происхождение	Проверка источника данных (аутентификация МИС, подпись запроса)	reject — данные не принимаются
- 📏 Единицы измерения	Валидация единиц (мм рт. ст. для АД, °C для температуры и т. д.)	reject с указанием несоответствия
- 📡 Качество сигнала	Проверка полноты и целостности пакета данных	degraded или reject
- 📊 Полнота	Наличие всех обязательных полей для расчёта	degraded — расчёт с пониженной полнотой
- 🔬 Протокол измерений	Соответствие данных заявленному протоколу (тип прибора, метод)	reject или warning
- ⚠️ Артефакты	Выявление технических артефактов (нулевые значения, дубли, выход за физические пределы)	reject артефактной точки

#### 3.2.3. 📄 Структура отчёта о качестве

```json
{
  "intake_id": "uuid",
  "source": "mis_ecoz",
  "source_auth_verified": true,
  "event_id": "external_event_id",
  "timestamp_received": "ISO-8601",
  "data_completeness": 0.92,
  "checks": [
    {
      "name": "units_validation",
      "status": "passed",
      "details": "All units within expected ranges"
    },
    {
      "name": "artifact_detection",
      "status": "warning",
      "details": "Duplicate BP reading detected, first instance retained"
    }
  ],
  "vitals_accepted": ["heart_rate", "systolic_bp", "diastolic_bp", "temperature"],
  "vitals_rejected": ["spo2"],
  "rejection_reasons": {
    "spo2": "Value 150 exceeds physiological range"
  }
}
```

### 3.3. 🧮 Версионированный движок расчёта HEALTH_ID
#### 3.3.1. 📐 Формула индекса (исследовательская версия)


$$
\text{HEALTH\_ID} = w_{\text{body}} \cdot h_{\text{body}} + w_{\text{mental}} \cdot h_{\text{mental}} + w_{\text{social}} \cdot h_{\text{social}}
$$


**Веса исследовательской версии:**

| Компонент | Обозначение | Вес |
| --- | --- | --- |
| 🫀 Физическое здоровье | $h_{\text{body}}$ | 0,60 |
| 🧠 Психическое здоровье | $h_{\text{mental}}$ | 0,25 |
| 🤝 Социальное здоровье | $h_{\text{social}}$ | 0,15 |

*Каждый компонент ($h_x$) рассчитывается как функция от нормированных признаков и сравнения с персональным коридором.*


#### 3.3.2. 🏷️ Версионирование модели
Каждая версия модели HEALTH_ID должна фиксировать полный артефакт расчёта:

```json
{
  "model_version": "health_id_v1.0.0",
  "version_date": "2026-09-14",
  "author": "researcher_id",
  "status": "experimental | validation_r0 | validation_r1 | ... | validated | deprecated",
  "components": {
    "h_body": {
      "weight": 0.60,
      "features": [
        {"name": "heart_rate", "unit": "bpm", "normal_range": [60, 100], "source": "vitals", "required": true},
        {"name": "systolic_bp", "unit": "mmHg", "normal_range": [100, 140], "source": "vitals", "required": true},
        {"name": "diastolic_bp", "unit": "mmHg", "normal_range": [60, 90], "source": "vitals", "required": true},
        {"name": "temperature", "unit": "celsius", "normal_range": [36.0, 37.5], "source": "vitals", "required": true},
        {"name": "spo2", "unit": "%", "normal_range": [95, 100], "source": "vitals", "required": false},
        {"name": "alcohol_test", "unit": "boolean", "normal_range": [false], "source": "vitals", "required": true}
      ],
      "formula": "weighted_z_score_relative_to_baseline",
      "normalization": "minmax_with_clipping_to_0_1",
      "thresholds": {
        "acute_deviation": "z > 3.0 from baseline OR any vital outside emergency_range",
        "persistent_deviation": "z > 2.0 from baseline on >= 2 unique dates",
        "chronic_confirmed": "diagnosis present in EMR/EHR from MIS"
      },
      "missing_data_rule": "exclude feature from calculation, adjust weight proportionally"
    },
    "h_mental": {
      "weight": 0.25,
      "features": [
        {"name": "sleep_quality", "source": "questionnaire", "required": false},
        {"name": "stress_level", "source": "questionnaire", "required": false},
        {"name": "cognitive_test_score", "source": "assessment", "required": false}
      ],
      "formula": "weighted_z_score_relative_to_baseline",
      "normalization": "minmax_with_clipping_to_0_1",
      "thresholds": {}
    },
    "h_social": {
      "weight": 0.15,
      "features": [
        {"name": "social_activity_score", "source": "contextual", "required": false},
        {"name": "work_engagement_score", "source": "contextual", "required": false}
      ],
      "formula": "weighted_z_score_relative_to_baseline",
      "normalization": "minmax_with_clipping_to_0_1",
      "thresholds": {}
    }
  },
  "global_rules": {
    "min_completeness": 0.40,
    "uncertainty_model": "weighted_missing_fraction",
    "quality_gates": {
      "reject_if": "completeness < 0.40 OR any required_feature_missing",
      "degrade_if": "completeness < 0.70"
    }
  },
  "config_hash": "SHA-256 of full config"
}
```
**Правила версионирования:**

📌 Семантическое версионирование (MAJOR.MINOR.PATCH);
🔄 Изменение весов, формул или порогов = **MINOR**;
➕ Изменение набора признаков = **MAJOR**;
🐛 Исправление багов без изменения логики = **PATCH**;
🔒 Каждая версия неизменна после публикации — изменение создаёт новую версию;
🔗 Версия модели связывается с каждым расчётом HEALTH_ID.

#### 3.3.3. 📈 Расчёт персональных коридоров (baseline)

**Алгоритм:**

- 📥 Сбор всех качественных (passed quality check) измерений работника за период;
- 🚫 **Исключение текущей точки** из расчёта baseline для предотвращения утечки данных (data leakage);
- 📊 Расчёт статистик по каждому признаку: медиана, IQR, среднее, стандартное отклонение;
- 📏 Определение персонального коридора: ([median - k \cdot IQR, median + k \cdot IQR]), где (k) — параметр версии (по умолчанию (k = 1{,}5));
- 🔢 Минимум 3 предыдущих качественных измерения для построения baseline; при недостатке данных используются популяционные нормы из конфигурации версии.

***Выходные данные (нормальный режим)***:

```json
{
  "worker_pseudonym": "SHA-256",
  "baseline_version": "baseline_v1.0.0",
  "model_version": "health_id_v1.0.0",
  "n_historical_points": 12,
  "current_point_excluded": true,
  "corridors": {
    "heart_rate": {
      "median": 72.0,
      "iqr": [68.0, 78.0],
      "corridor": [60.5, 85.5],
      "source": "personal"
    },
    "systolic_bp": {
      "median": 120.0,
      "iqr": [115, 128],
      "corridor": [104.5, 138.5],
      "source": "personal"
    }
  },
  "fallback_used": false,
  "fallback_reason": null
}
```
Выходные данные (недостаточно персональных данных — fallback):

```json
{
  "corridors": {
    "heart_rate": {
      "median": 75.0,
      "iqr": [65.0, 85.0],
      "corridor": [50.0, 100.0],
      "source": "population_norm"
    }
  },
  "fallback_used": true,
  "fallback_reason": "insufficient_personal_data (< 3 quality points)",
  "n_historical_points": 1
}
```

#### 3.3.4. 🚦 Классификация состояния
Три типа отклонений:

🔴 **Острое отклонение** — единичное измерение с экстремальным выходом за пределы:

- ∣z∣>3,0 от персонального baseline **или**
- значение вне диапазона `emergency_range` из конфигурации;
- флаг `is_acute = true`;
- ⚡ Требует немедленного уведомления медицинского работника.

🟡 **Устойчивое повторное отклонение** — отклонение фиксируется по **уникальным датам**, а не по числу попыток:

- ∣z∣>2,0 от baseline на 2 и более уникальных датах за период наблюдения;
- флаг `is_persistent = true`;
📅 Не учитываются повторные измерения в тот же день (только первая качественная точка за дату).

🔵 **Клинически подтверждённое хроническое состояние** — источник: только МИС/ЭМК:

- Наличие диагноза в электронной медицинской карте (код МКБ-10);
- Флаг `is_chronic = true`;
- 🏥 Источник: `emr` (не выводится из витальных показателей).

***Логика классификации (псевдокод)***:

```python
def classify_state(current_measurement, baseline, historical_points, emr_diagnoses):
    z_scores = calculate_z_scores(current_measurement, baseline)

    # 🔴 Acute: any feature beyond emergency range or z > 3.0
    is_acute = any(
        z > 3.0 or is_emergency(value, feature)
        for feature, (z, value) in z_scores.items()
    )

    # 🟡 Persistent: z > 2.0 on >= 2 unique dates
    unique_deviation_dates = set(
        point.date for point in historical_points
        if point.z_score > 2.0 and point.quality == "passed"
    )
    if current_measurement.z_score > 2.0:
        unique_deviation_dates.add(current_measurement.date)
    is_persistent = len(unique_deviation_dates) >= 2

    # 🔵 Chronic: only from EMR
    is_chronic = len(emr_diagnoses) > 0

    return StateClassification(
        is_acute=is_acute,
        is_persistent=is_persistent,
        is_chronic=is_chronic,
        acute_features=[f for f, (z, v) in z_scores.items() if z > 3.0],
        persistent_dates=sorted(unique_deviation_dates),
        chronic_diagnoses=emr_diagnoses
    )
```

### 3.4. 📤 Выходной контракт расчёта HEALTH_ID
Полная структура ответа API расчёта:

```json
{
  "calculation_id": "uuid",
  "timestamp": "ISO-8601",
  "model_version": "health_id_v1.0.0",
  "config_hash": "SHA-256",
  "worker_pseudonym": "SHA-256 hash",
  "event_id": "external_event_id",

  "health_id": {
    "value": 0.78,
    "scale": [0, 1],
    "interpretation": "within_normal_range"
  },

  "components": [
    {
      "name": "h_body",
      "weight": 0.60,
      "value": 0.82,
      "contribution": 0.492,
      "contribution_percent": 63.1,
      "features": [
        {
          "name": "heart_rate",
          "measured_value": 72,
          "unit": "bpm",
          "baseline_corridor": [60.5, 85.5],
          "z_score": 0.12,
          "normalized": 0.95,
          "contribution": 0.19,
          "quality": "passed",
          "source": "vitals",
          "input_id": "vit_001"
        },
        {
          "name": "systolic_bp",
          "measured_value": 130,
          "unit": "mmHg",
          "baseline_corridor": [104.5, 138.5],
          "z_score": 0.45,
          "normalized": 0.78,
          "contribution": 0.16,
          "quality": "passed",
          "source": "vitals",
          "input_id": "vit_002"
        }
      ],
      "completeness": 1.0,
      "missing_features": []
    },
    {
      "name": "h_mental",
      "weight": 0.25,
      "value": 0.65,
      "contribution": 0.163,
      "contribution_percent": 20.9,
      "features": [],
      "completeness": 0.33,
      "missing_features": ["sleep_quality", "cognitive_test_score"]
    },
    {
      "name": "h_social",
      "weight": 0.15,
      "value": null,
      "contribution": 0.0,
      "contribution_percent": 0.0,
      "features": [],
      "completeness": 0.0,
      "missing_features": ["social_activity_score", "work_engagement_score"]
    }
  ],

  "overall_completeness": 0.58,
  "uncertainty": {
    "level": "medium",
    "score": 0.42,
    "model": "weighted_missing_fraction",
    "explanation": "42% of weighted features unavailable; h_social entirely missing"
  },

  "state_classification": {
    "is_acute": false,
    "is_persistent": false,
    "is_chronic": false,
    "acute_features": [],
    "persistent_dates": [],
    "chronic_diagnoses": [],
    "personal_deviation": {
      "features_with_deviation": ["systolic_bp"],
      "max_z_score": 0.45,
      "interpretation": "within_personal_baseline"
    }
  },

  "evidence": {
    "input_ids": ["vit_001", "vit_002", "vit_003", "vit_004", "vit_005"],
    "data_quality": {
      "intake_report_id": "intake_uuid",
      "completeness": 0.58,
      "rejected_features": ["spo2"],
      "rejection_reasons": {"spo2": "Value out of physiological range"}
    },
    "baseline": {
      "baseline_version": "baseline_v1.0.0",
      "n_historical_points": 12,
      "current_point_excluded": true,
      "fallback_used": false
    },
    "formulas": {
      "h_body": "weighted_z_score_relative_to_baseline",
      "h_mental": "weighted_z_score_relative_to_baseline",
      "h_social": "weighted_z_score_relative_to_baseline",
      "global": "weighted_sum_with_proportional_reweighting"
    },
    "norms": {
      "heart_rate": [60, 100],
      "systolic_bp": [100, 140],
      "diastolic_bp": [60, 90],
      "temperature": [36.0, 37.5]
    },
    "contribution_trace": [
      {"step": 1, "description": "Data intake and validation", "result": "5 features accepted, 1 rejected"},
      {"step": 2, "description": "Baseline calculation", "result": "12 historical points, current excluded"},
      {"step": 3, "description": "Z-score computation", "result": "All within personal corridor"},
      {"step": 4, "description": "Normalization", "result": "Min-max with clipping to [0,1]"},
      {"step": 5, "description": "Component calculation", "result": "h_body=0.82, h_mental=0.65, h_social=null"},
      {"step": 6, "description": "Weight aggregation with proportional reweighting", "result": "HEALTH_ID=0.78"},
      {"step": 7, "description": "State classification", "result": "No acute, persistent, or chronic conditions"}
    ]
  },

  "audit": {
    "calculation_time_ms": 145,
    "engine_version": "health_id_engine_v1.0.0",
    "config_snapshot": "full config JSON hash reference",
    "warnings": ["h_social component entirely missing — proportional reweighting applied"]
  }
}
```

### 3.5. 🩺 Модуль клинической проверки (human review)
#### 3.5.1. 🔄 Workflow

[Расчёт HEALTH_ID] → [auto: если is_acute OR uncertainty.level == high]
                      → [создание review task, status=pending]
                      → [уведомление медработника]
                      → [медработник: просмотр evidence, комментарий, решение]
                      → [status: confirmed / rejected]
                      → [запись в аудит, обновление статуса расчёта]

Триггеры автоматического создания review task:

🔴 is_acute = true;
⚠️ uncertainty.level == "high";
📉 overall_completeness < 0.50;
✋ Ручной запрос от медработника.

#### 3.5.2. 📋 Структуры данных

```json
{
    "review_id": "uuid",
    "calculation_id": "uuid",
    "status": "pending | confirmed | rejected",
    "priority": "routine | urgent",
    "trigger": "acute_flag | high_uncertainty | low_completeness | manual",
    "created_at": "ISO-8601",
    "reviewed_at": null,
    "reviewer_id": null,
    "reviewer_qualification": null,
    "comment": null,
    "evidence_attachments": [],
    "decision_rationale": null,
    "audit_trail": [
        {
            "action": "created",
            "actor": "system",
            "timestamp": "ISO-8601",
            "details": "Auto-created: is_acute=true"
        },
        {
            "action": "reviewed",
            "actor": "medworker_pseudonym",
            "timestamp": "ISO-8601",
            "details": "Confirmed: values consistent with worker's history"
        }
    ]
}
```
#### 3.5.3. 🖥️ Интерфейс медработника
Веб-интерфейс (страница в Replit-приложении) должен отображать:

📊 Сводку HEALTH_ID с компонентами и вкладом;
🔍 Полный evidence: исходные значения, baseline, формулы, contribution_trace;
🚩 Флаги острых/устойчивых/хронических отклонений;
❓ Оценку неопределённости и полноты;
✏️ Форму для комментария и принятия решения (confirmed/rejected);
📈 Историю предыдущих расчётов работника (динамика).

***Требования к подписи***:

🔏 Решение медработника фиксируется с использованием усиленной квалифицированной электронной подписи (УКЭП) в соответствии с п. 7 ст. 36.2 ФЗ-323;
🔑 Аутентификация медработника — через ЕСИА (ФГИС ЕСИА) в соответствии с ПП РФ № 866;
📋 Медработник должен быть внесён в ЕГИСЗ (Федеральный реестр медицинских работников).
3.6. 🏛️ Подсистема model governance
3.6.1. 📇 Model card

***Структура model card для каждой версии HEALTH_ID***:

```json
{
  "model_card_id": "uuid",
  "model_version": "health_id_v1.0.0",
  "title": "HEALTH_ID Research Index v1.0.0",
  "description": "Experimental composite health index for periodic medical examinations",
  "intended_use": "Research only — not for clinical decision-making until R4 validation complete",
  "prohibited_uses": [
    "Automated medical disqualification",
    "Employment decisions",
    "Insurance underwriting",
    "Any use outside research context before validation completion"
  ],
  "methodology": {
    "formula": "weighted_sum",
    "components": ["h_body", "h_mental", "h_social"],
    "weights": [0.60, 0.25, 0.15],
    "baseline_method": "personal IQR-based corridors",
    "normalization": "minmax with clipping"
  },
  "training_data": {
    "description": "Anonymized ProMO dataset",
    "n_events": 2967,
    "n_workers": 23,
    "period": "2025-2026",
    "preprocessing": "deduplication, artifact removal, quality filtering"
  },
  "validation_status": {
    "r0_analytical": "passed | failed | in_progress",
    "r1_retrospective": "passed | failed | in_progress",
    "r2_external_prospective": "passed | failed | not_started",
    "r3_clinical_utility": "passed | failed | not_started",
    "r4_final": "passed | failed | not_started"
  },
  "known_limitations": [
    "Small sample size (n=23 workers)",
    "h_social component lacks validated measurement instruments",
    "Baseline stability not assessed beyond 12 months"
  ],
  "ethical_considerations": "See attached ethics committee approval",
  "contact": "research_team_contact",
  "last_updated": "ISO-8601"
}
```

#### 3.6.2. 📒 Журнал версий
| Поле | Тип | Описание |
| --- | --- |
| version_id | UUID | Уникальный идентификатор версии |
| model_version | string | Семантическая версия (health_id_v1.0.0) |
| parent_version | string/null | Предыдущая версия |
| change_type | enum | MAJOR / MINOR / PATCH
| change_description | text | Описание изменений
| config_snapshot | JSON | Полный конфигурационный снапшот
| config_hash | string | SHA-256 хеш конфигурации
| created_by | string | Идентификатор автора
| created_at | timestamp | Дата создания
| status | enum | experimental → validation_r0 → … → validated → deprecated
| validation_reports | JSON[] | Ссылки на отчёты валидации R0–R4

#### 3.6.3. 🧪 Валидационные тесты
```python
# tests/validation/test_model_v1_0_0.py

class TestHEALTH_IDv1_0_0:
    def test_reproducibility(self):
        """Одинаковые входные данные → одинаковый результат"""

    def test_deterministic_with_same_config(self):
        """Тот же config_hash → тот же результат"""

    def test_baseline_excludes_current_point(self):
        """Текущая точка не входит в baseline"""

    def test_persistent_counts_unique_dates(self):
        """Устойчивое отклонение: 2 точки в один день = 1 уникальная дата"""

    def test_acute_threshold(self):
        """z > 3.0 → is_acute = true"""

    def test_completeness_propagation(self):
        """Понижение полноты → повышение неопределённости"""

    def test_proportional_reweighting(self):
        """Отсутствие компонента → перераспределение весов"""

    def test_evidence_trace_completeness(self):
        """contribution_trace содержит все шаги расчёта"""

    def test_no_data_leakage(self):
        """Персональный baseline не содержит текущую точку"""

    def test_emergency_range_overrides_baseline(self):
        """Выход за emergency_range → is_acute независимо от baseline"""
```  

#### 3.6.4. 📉 Отслеживание дрейфа данных
```python
class DriftMonitor:
    """
    📉 Мониторинг дрейфа входных данных и распределения HEALTH_ID.
    Проверяет:
    - Сдвиг распределения витальных показателей (PSI)
    - Изменение доли пропущенных данных
    - Сдвиг распределения HEALTH_ID
    - Изменение доли acute/persistent флагов
    """

    metrics = {
        "psi_vitals": "Population Stability Index per feature",
        "missing_rate": "Fraction of missing features over time",
        "health_id_distribution": "Mean, std, percentiles of HEALTH_ID over rolling window",
        "acute_rate": "Rate of is_acute=true per 100 events",
        "persistent_rate": "Rate of is_persistent=true per 100 events"
    }

    alert_thresholds = {
        "psi": 0.25,          # PSI > 0.25 → значительный дрейф
        "missing_rate_delta": 0.15,
        "health_id_mean_shift": 0.1
    }
```    

### 3.7. 🔌 API
#### 3.7.1. 🌐 Эндпоинты
#### 3.7.1. 🌐 Эндпоинты

| Метод | Путь | Назначение | Контур |
| --- | --- | --- | --- |
| `POST` | `/api/v1/verify` | Запуск биометрической верификации | 🏥 Медицинский |
| `GET` | `/api/v1/verify/{id}` | Получение результата верификации | 🏥 Медицинский |
| `POST` | `/api/v1/data/intake` | Приём данных из МИС ЕЦОЗ | 🏥 Медицинский |
| `POST` | `/api/v1/health_id/calculate` | Расчёт `HEALTH_ID` | 🏥 Медицинский |
| `GET` | `/api/v1/health_id/{calculation_id}` | Получение результата расчёта | 🏥 Медицинский |
| `GET` | `/api/v1/health_id/{worker_pseudonym}/dynamics` | Динамика состояния работника | 🏥 Медицинский |
| `POST` | `/api/v1/review` | Создание review task | 🏥 Медицинский |
| `GET` | `/api/v1/review/pending` | Список ожидающих review | 🏥 Медицинский |
| `PUT` | `/api/v1/review/{id}` | Обновление статуса review | 🏥 Медицинский |
| `GET` | `/api/v1/model/card/{version}` | Получение model card | 🏥 Оба |
| `GET` | `/api/v1/model/versions` | Журнал версий | 🏥 Оба |
| `GET` | `/api/v1/model/drift/report` | Отчёт о дрейфе данных | 🏥 Медицинский |
| `GET` | `/api/v1/health_id/{calculation_id}/evidence` | Полный evidence расчёта | 🏥 Медицинский |
| `GET` | `/api/v1/health_id/export` | Экспорт данных исследования (обезличенных) | 🔬 Исследовательский |


#### 3.7.2. 🔐 Аутентификация и авторизация

- **OAuth2 + JWT** для всех эндпоинтов;
- 🔑 Интеграция с **ЕСИА** для аутентификации медицинских работников;
- 👥 Ролевая модель доступа:

| Роль | Доступ |
| --- | --- |
| 🩺 `medical_worker` | Верификация, расчёт, review, динамика, evidence |
| 🔬 `researcher` | Экспорт обезличенных данных, model card, drift report |
| 💼 `corporate_hr` | Только агрегированная статистика (нет доступа к `HEALTH_ID`) |
| 🛡️ `admin` | Управление версиями, конфигурациями |

#### 3.7.3. ⏱️ Ограничения API
- 🚦 Rate limiting: 100 запросов/мин на пользователя;
- 📦 Максимальный размер видеофайла: 50 MB;
- 📦 Максимальный размер JSON-пакета данных: 5 MB;
- ⏳ Timeout обработки: 30 секунд для верификации, 10 секунд для расчёта HEALTH_ID.


## 4. 🗄️ Требования к данным
### 4.1. Схема базы данных (основные таблицы)
```sql
-- Верификации
CREATE TABLE verifications (
    verification_id UUID PRIMARY KEY,
    worker_pseudonym VARCHAR(64) NOT NULL,
    event_id VARCHAR(128),
    status VARCHAR(20) NOT NULL CHECK (status IN ('verified', 'manual_review', 'not_verified')),
    face_match_score FLOAT,
    liveness_score FLOAT,
    quality_score FLOAT,
    pipeline_version VARCHAR(32) NOT NULL,
    config_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMP,
    full_result JSONB NOT NULL
);

-- Версии модели
CREATE TABLE model_versions (
    version_id UUID PRIMARY KEY,
    model_version VARCHAR(64) UNIQUE NOT NULL,
    parent_version VARCHAR(64),
    change_type VARCHAR(10) NOT NULL,
    change_description TEXT,
    config_snapshot JSONB NOT NULL,
    config_hash VARCHAR(64) NOT NULL,
    created_by VARCHAR(128) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    status VARCHAR(20) NOT NULL DEFAULT 'experimental'
);

-- Расчёты HEALTH_ID
CREATE TABLE health_id_calculations (
    calculation_id UUID PRIMARY KEY,
    worker_pseudonym VARCHAR(64) NOT NULL,
    event_id VARCHAR(128),
    model_version VARCHAR(64) NOT NULL REFERENCES model_versions(model_version),
    config_hash VARCHAR(64) NOT NULL,
    health_id_value FLOAT NOT NULL,
    completeness FLOAT NOT NULL,
    uncertainty_score FLOAT NOT NULL,
    is_acute BOOLEAN DEFAULT FALSE,
    is_persistent BOOLEAN DEFAULT FALSE,
    is_chronic BOOLEAN DEFAULT FALSE,
    full_result JSONB NOT NULL,
    evidence JSONB NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    FOREIGN KEY (model_version) REFERENCES model_versions(model_version)
);

-- Review tasks
CREATE TABLE review_tasks (
    review_id UUID PRIMARY KEY,
    calculation_id UUID NOT NULL REFERENCES health_id_calculations(calculation_id),
    status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected')),
    priority VARCHAR(10) NOT NULL CHECK (priority IN ('routine', 'urgent')),
    trigger VARCHAR(50) NOT NULL,
    reviewer_id VARCHAR(128),
    reviewer_qualification VARCHAR(128),
    comment TEXT,
    decision_rationale TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMP,
    audit_trail JSONB NOT NULL DEFAULT '[]'
);

-- Baseline
CREATE TABLE baselines (
    baseline_id UUID PRIMARY KEY,
    worker_pseudonym VARCHAR(64) NOT NULL,
    model_version VARCHAR(64) NOT NULL,
    baseline_version VARCHAR(64) NOT NULL,
    n_historical_points INT NOT NULL,
    current_point_excluded BOOLEAN NOT NULL DEFAULT TRUE,
    corridors JSONB NOT NULL,
    fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
    fallback_reason TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Журнал аудита
CREATE TABLE audit_log (
    audit_id UUID PRIMARY KEY,
    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID NOT NULL,
    action VARCHAR(50) NOT NULL,
    actor VARCHAR(128) NOT NULL,
    actor_role VARCHAR(50) NOT NULL,
    timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
    details JSONB,
    ip_address INET,
    user_agent TEXT
);

-- Дрейф данных
CREATE TABLE drift_reports (
    report_id UUID PRIMARY KEY,
    model_version VARCHAR(64) NOT NULL,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    metrics JSONB NOT NULL,
    alerts JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

---

### 4.2. 🕵️ Обезличивание данных
- 🆔 **worker_pseudonym** — SHA-256 хеш от уникального идентификатора работника + соли;
- 🔒 Таблица соответствия pseudonym → реальный идентификатор хранится в отдельной защищённой таблице с доступом только у администратора;
- 📤 При экспорте данных для исследования используются только pseudonym — без возможности обратной идентификации;
- 🧬 Биометрические embeddings хранятся отдельно от pseudonym-маппинга.

---

## 5. 🛡️ Требования безопасности

### 5.1. 📜 Соответствие 152-ФЗ (персональные данные)

- ✍️ **Письменное согласие** субъекта на обработку биометрических ПДн (ст. 11 ФЗ-152);
- 📄 Согласие оформляется **отдельным документом** (с 01.09.2025 — требование ст. 9 ФЗ-152);
- 🚫 Предоставление биометрических данных **не может быть обязательным** (ч. 3 ст. 11 ФЗ-152) — работник вправе отказаться, в этом случае верификация выполняется медработником вручную;
- ⏳ Срок хранения ПДн ограничен целями обработки (до завершения исследования или отзыва согласия);
- ⚖️ Запрет на отказ в обслуживании при отказе от предоставления биометрии.

### 5.2. 🏥 Разделение контуров
- 🔒 Медицинские данные (биометрия, витальные показатели, HEALTH_ID) **не передаются** в корпоративный контур;
- 📤 В корпоративный контур передаётся только: факт прохождения/непрохождения, медицинское заключение (допуск/недопуск) — подписанное УКЭП медработника;
- 🚷 Корпоративный контур не имеет обратного доступа к медицинскому;
- 📝 Логирование всех запросов между контурами.

### 5.3. 🔧 Технические меры
| Мера | Реализация |
| --- | --- |
| 🔐 Шифрование at-rest | AES-256 для БД и файлового хранилища |
| 🔒 Шифрование in-transit | TLS 1.3 для всех соединений |
| 🕵️ Маскирование | Псевдонимизация всех идентификаторов |
| 📝 Аудит | Логирование всех действий с данными (кто, когда, что, зачем) |
| 💾 Резервное копирование | Ежедневное, с шифрованием бэкапов |
| 🔑 Контроль доступа | RBAC + ABAC, principle of least privilege |
| ⏱️ Сессии | JWT с коротким TTL, refresh tokens |
| 🛡️ Защита от инъекций | Параметризованные запросы, валидация ввода |
| 📦 Загрузка файлов | Проверка MIME-type, ограничение размера, антивирусная проверка |

### 5.4. 👩‍⚕️ Требования к медицинскому работнику
🎓 Медработник должен иметь высшее и/или среднее профессиональное медицинское образование;
📚 Пройти обучение по программе повышения квалификации по вопросам проведения медосмотров с использованием медизделий (не менее 36 часов);
📋 Быть внесён в ЕГИСЗ (Федеральный реестр медицинских работников);
🔑 Иметь подтверждённую учётную запись в ЕСИА;
🔏 Подписывать медицинские заключения УКЭП.

---

## 6. 🧪 Протоколы валидации R0–R4
**R0. 📐 Аналитическая валидация**
**Цель**: Демонстрация корректности расчёта, воспроизводимости и отсутствия ошибок реализации.

Критерий	Метод приемки
✅ Воспроизводимость	Одинаковые входы → одинаковый HEALTH_ID (100 тестов)
📋 Полнота evidence	Все шаги расчёта трассируются (audit по каждому расчёту)
🚫 Изоляция baseline	Текущая точка никогда не входит в персональный baseline
🎯 Пороговые значения	z > 3.0 → is_acute; 2 уникальные даты → is_persistent
🏷️ Версионирование	Смена версии меняет config_hash; старые расчёты не пересчитываются
🧪 Unit-тесты	Покрытие ≥ 90% для core-модулей
**Документ**: Отчёт R0 с результатами всех тестов, примерами расчётов, таблицей покрытия.

**R1. 📊 Ретроспективная валидация**
**Цель**: Проверка на исторических данных (2 967 событий, 23 работника).

Критерий	Метод
📊 Распределение HEALTH_ID	Гистограмма, квартили, выбросы
🔗 Связь с клиническими событиями	Корреляция HEALTH_ID с известными диагнозами из ЭМК
📈 Стабильность baseline	Коэффициент вариации персональных коридоров во времени
📉 Дрейф данных	PSI < 0.25 для каждого признака по периодам
⚠️ False positive rate	Доля is_acute при отсутствии клинического подтверждения
⚠️ False negative rate	Пропущенные острые состояния (по ретроспективной оценке)
**Документ**: Отчёт R1 с описательным анализом, статистическими тестами, выводами о пригодности модели.

**R2. 🔭 Внешняя проспективная валидация**
**Цель**: Проверка на новых данных, не участвовавших в R1.

Критерий	Метод
🔮 Прогностическая валидность	Связь низкого HEALTH_ID с будущими клиническими событиями
🎚️ Калибровка	Соответствие предсказанных и наблюдаемых частот отклонений
🔄 Внешняя воспроизводимость	Повтор расчёта на независимом наборе
📉 Устойчивость к шуму	Влияние добавления искусственного шума на HEALTH_ID
**Документ**: Отчёт R2 с протоколом сбора данных, статистическим анализом, выводами.

**R3. 🩺 Клиническая полезность**
**Цель**: Оценка того, помогает ли HEALTH_ID медицинскому работнику принимать решения.

Критерий	Метод
🎯 Полезность для медработника	Опросник medworkers после использования (Likert scale)
⏱️ Влияние на время решения	Сравнение времени review с/без HEALTH_ID
🎯 Влияние на точность	Сравнение согласованности решений с экспертной оценкой
💡 Объяснимость	Оценка понятности evidence medworkers (качественное интервью)
**Документ**: Отчёт R3 с результатами опросов, временным анализом, рекомендациями по доработке.

**R4. ✅ Итоговая валидация и решение о готовности**
**Цель**: Принятие решения о готовности к выводу из исследовательского режима.

Критерий	Метод
📋 Интегральная оценка	Сводка результатов R0–R3 с итоговым заключением
⚖️ Регуляторное соответствие	Чек-лист соответствия 323-ФЗ, 152-ФЗ, ПП РФ № 866, рекомендациям Росздравнадзора
🗺️ План перехода	Дорожная карта перевода из research → production
⚠️ Ограничения	Зафиксированные ограничения и условия применения
**Документ**: Итоговый отчёт R4 с рекомендацией: `approved_for_production` / `requires_revision` / `not_recommended`.

---

## 7. ⚙️ Нефункциональные требования
Параметр	Требование
⏱️ Время отклика API (расчёт HEALTH_ID)	≤ 2 секунды на 1 событие
⏱️ Время обработки видео	≤ 10 секунд для 3-секундного ролика
📡 Доступность	99.5% (исследовательский режим)
📈 Масштабируемость	До 100 одновременных расчётов
📝 Логирование	Все действия, retention — 3 года
💾 Резервное копирование	Ежедневное, хранение 30 дней
🚀 Развертывание	Docker-контейнер в Replit, с возможностью миграции
🌐 Язык интерфейса	Русский
📖 Документация	Markdown + автогенерация API-документации (OpenAPI/Swagger)

---

## 8. 📁 Структура проекта в Replit
```text
.replit                         # Конфигурация Replit-приложения
replit.nix                      # Системные зависимости (Nix)
pyproject.toml                  # Python-зависимости (poetry/pip)
.env.example                    # Пример переменных окружения

app/
├── main.py                     # Точка входа FastAPI
├── config/
│   ├── settings.py             # Настройки (из .env)
│   └── model_versions/         # JSON-конфиги версий модели
│       ├── health_id_v1.0.0.json
│       └── health_id_v1.1.0.json
├── core/
│   ├── biometric/
│   ├── data_intake/
│   ├── engine/
│   ├── review/
│   └── governance/
├── api/
│   ├── routes/
│   └── deps.py                 # Зависимости (аутентификация, БД)
├── db/
│   ├── models.py               # SQLAlchemy models
│   ├── migrations/             # Alembic migrations
│   └── seed.py                 # Начальные данные
├── static/                     # Статические файлы UI
├── templates/                  # Jinja2-шаблоны (UI медработника)
└── tests/
    ├── unit/
    ├── integration/
    ├── e2e/
    └── validation/             # Тесты валидации R0

docs/
├── architecture.md
├── api_reference.md
├── deployment_guide.md
├── validation/
│   ├── R0_analytical.md
│   ├── R1_retrospective.md
│   ├── R2_external_prospective.md
│   ├── R3_clinical_utility.md
│   └── R4_final_report.md
└── regulatory_compliance.md
``` 

---

## 9. 🗓️ Этапы и сроки реализации
Этап	Содержание	Длительность
- 🏗️ 1. Инфраструктура	Настройка Replit, БД, базовая структура, аутентификация	1 неделя
- 📷 2. Модуль биометрии	face_match, liveness, quality, router	2 недели
- 📥 3. Модуль приёма данных	Интеграция с МИС ЕЦОЗ, валидация, качество	1 неделя
- 🧮 4. Движок HEALTH_ID	Версионирование, baseline, классификация, выходной контракт	2 недели
- 🩺 5. Human review	Workflow, UI медработника, аудит	1 неделя
- 🏛️ 6. Model governance	Model card, журнал версий, тесты, дрейф	1 неделя
- 🔌 7. API	Все эндпоинты, документация OpenAPI	1 неделя
- 📐 8. Валидация R0	Аналитические тесты, отчёт	1 неделя
- 📊 9. Валидация R1	Ретроспективный анализ на 2 967 событий	2 недели
- 📖 10. Документация	Полная документация, регуляторное соответствие	1 неделя
**Итого:** ~13 недель (≈ 3 месяца) до завершения R1.

---

## 10. ✅ Критерии приёмки
- ✅ **Воспроизводимость расчёта** — 100% тестов на воспроизводимость проходят;
- 📋 **Прослеживаемость** — для каждого расчёта HEALTH_ID доступен полный evidence с input_ids, формулами, нормами и contribution_trace;
- 🏷️ **Версионирование** — каждая версия модели зафиксирована, не изменяется после публикации, связана с каждым расчётом;
- 💡 **Объяснимость** — медработник может просмотреть полный trace расчёта в UI и принять клиническое решение;
- 🩺 **Human review** — все расчёты с `is_acute` или высокой неопределённостью автоматически направляются на review;
- 🔒 **Разделение контуров** — корпоративный контур не имеет доступа к медицинским данным;
- ⚖️ **Регуляторное соответствие** — согласия на обработку биометрии, аутентификация через ЕСИА, подписание УКЭП;
- 📐 **Валидация R0** — отчёт об аналитической валидации с результатами всех тестов;
- 📊 **Валидация R1** — отчёт о ретроспективном анализе на наборе из 2 967 событий;
- 📖 **Документация** — полная документация API, архитектуры, регуляторного соответствия.

## 🏁 Конец ТЗ

