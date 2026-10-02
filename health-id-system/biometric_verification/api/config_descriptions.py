"""
config_descriptions.py — словарь русских названий и описаний
для параметров конфигурации модели биометрической верификации.

Импортируется в server.py для эндпоинтов /api/governance/model-config.
"""

CONFIG_PARAMETER_DESCRIPTIONS = {
    "face_size": {
        "name_ru": "Размер лица",
        "description": "Целевой размер изображения лица (ширина, высота) в пикселях для подачи в модель",
        "category": "preprocessing",
    },
    "face_padding": {
        "name_ru": "Отступ вокруг лица",
        "description": "Дополнение в пикселях вокруг bounding box лица при кропе",
        "category": "preprocessing",
    },
    "min_face_size": {
        "name_ru": "Минимальный размер лица",
        "description": "Минимальная ширина/высота лица в пикселях; лица меньше этого размера отбрасываются",
        "category": "detection",
    },
    "model_version": {
        "name_ru": "Версия модели",
        "description": "Идентификатор версии модели биометрической верификации",
        "category": "meta",
    },
    "parent_version": {
        "name_ru": "Родительская версия",
        "description": "Версия модели, от которой унаследована текущая (null — базовая версия)",
        "category": "meta",
    },
    "match_threshold": {
        "name_ru": "Порог совпадения",
        "description": "Минимальное косинусное сходство эмбеддингов (0–1), при котором лица считаются совпавшими",
        "category": "matching",
    },
    "manual_review_threshold": {
        "name_ru": "Порог ручной проверки",
        "description": "Сходство ниже этого порога отправляется на ручную проверку оператором",
        "category": "matching",
    },
    "quality_max_yaw": {
        "name_ru": "Максимальный поворот головы (yaw)",
        "description": "Максимально допустимый угол поворота головы влево/вправо в градусах",
        "category": "quality",
    },
    "quality_max_roll": {
        "name_ru": "Максимальный наклон головы (roll)",
        "description": "Максимально допустимый наклон головы влево/вправо в градусах",
        "category": "quality",
    },
    "quality_max_pitch": {
        "name_ru": "Максимальный наклон головы (pitch)",
        "description": "Максимально допустимый наклон головы вверх/вниз в градусах",
        "category": "quality",
    },
    "quality_min_fps": {
        "name_ru": "Минимальная частота кадров",
        "description": "Минимальное количество кадров в секунду в видео для корректного анализа",
        "category": "quality",
    },
    "quality_min_duration_sec": {
        "name_ru": "Минимальная длительность видео",
        "description": "Минимальная длительность видео в секундах для прохождения проверки качества",
        "category": "quality",
    },
    "quality_min_resolution": {
        "name_ru": "Минимальное разрешение",
        "description": "Минимальное разрешение видео (ширина, высота) в пикселях",
        "category": "quality",
    },
    "quality_min_lighting": {
        "name_ru": "Минимальная освещённость",
        "description": "Минимальный уровень освещённости лица (0–100) для пригодного кадра",
        "category": "quality",
    },
    "quality_max_blur": {
        "name_ru": "Максимальный размытие",
        "description": "Максимально допустимый уровень размытия кадра (чем больше — тем сильнее размытие)",
        "category": "quality",
    },
    "quality_max_occlusion_pct": {
        "name_ru": "Максимальная окклюзия лица",
        "description": "Максимальный процент перекрытия лица (0–100), при котором кадр ещё принимается",
        "category": "quality",
    },
    "quality_min_face_area_pct": {
        "name_ru": "Минимальная площадь лица",
        "description": "Минимальный процент площади лица от кадра (0–100)",
        "category": "quality",
    },
    "detector_backend": {
        "name_ru": "Детектор лиц",
        "description": "Бэкенд детекции лиц: haar (каскады Хаара), mtcnn, retinaface и др.",
        "category": "detection",
    },
    "detection_scale_factor": {
        "name_ru": "Коэффициент масштабирования детекции",
        "description": "Множитель уменьшения изображения на каждой итерации каскада Хаара",
        "category": "detection",
    },
    "detection_min_neighbors": {
        "name_ru": "Минимальное число соседей детекции",
        "description": "Минимальное количество перекрывающихся областей для подтверждения лица",
        "category": "detection",
    },
    "embedding_method": {
        "name_ru": "Метод эмбеддинга",
        "description": "Метод извлечения признаков: hog_lbp (гистограммы направленных градиентов + локальный бинарный паттерн)",
        "category": "embedding",
    },
    "min_detected_frames": {
        "name_ru": "Минимальное число кадров с лицом",
        "description": "Минимальное количество кадров, в которых обнаружено лицо, для успешной верификации",
        "category": "pipeline",
    },
    "max_frames_to_analyze": {
        "name_ru": "Максимум кадров для анализа",
        "description": "Максимальное количество кадров, которые анализируются из видео",
        "category": "pipeline",
    },
    "frame_sample_strategy": {
        "name_ru": "Стратегия выборки кадров",
        "description": "Способ выбора кадров из видео: uniform (равномерно по длительности)",
        "category": "pipeline",
    },
}

CATEGORY_NAMES = {
    "preprocessing": "Предобработка",
    "detection": "Детекция лиц",
    "quality": "Контроль качества",
    "matching": "Сравнение лиц",
    "embedding": "Извлечение признаков",
    "pipeline": "Пайплайн верификации",
    "meta": "Метаданные",
    "other": "Прочее",
}


def enrich_config(config: dict) -> list[dict]:
    """
    Обогащает конфигурацию русскими названиями и описаниями.

    Args:
        config: сырой словарь конфигурации из БД

    Returns:
        Список словарей с ключами:
        key, name_ru, description, category, value, value_type
    """
    result = []
    for key, value in config.items():
        meta = CONFIG_PARAMETER_DESCRIPTIONS.get(key, {})
        result.append({
            "key": key,
            "name_ru": meta.get("name_ru", key),
            "description": meta.get("description", ""),
            "category": meta.get("category", "other"),
            "value": value,
            "value_type": type(value).__name__,
        })
    return result


def group_config_by_category(config: dict) -> list[dict]:
    """
    Группирует конфигурацию по категориям для плоского вывода.

    Args:
        config: сырой словарь конфигурации из БД

    Returns:
        Список категорий с параметрами:
        [{key, name_ru, parameters: [{key, name_ru, description, value}]}]
    """
    by_category: dict[str, list] = {}
    for key, value in config.items():
        meta = CONFIG_PARAMETER_DESCRIPTIONS.get(key, {})
        cat = meta.get("category", "other")
        entry = {
            "key": key,
            "name_ru": meta.get("name_ru", key),
            "description": meta.get("description", ""),
            "value": value,
        }
        by_category.setdefault(cat, []).append(entry)

    return [
        {
            "key": cat_key,
            "name_ru": CATEGORY_NAMES.get(cat_key, cat_key),
            "parameters": params,
        }
        for cat_key, params in by_category.items()
    ]
