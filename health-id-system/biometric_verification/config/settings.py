"""
Конфигурация модели: пороги, параметры, хеш.
"""
from __future__ import annotations
import hashlib, json, os
from dataclasses import dataclass, field, asdict
from enum import Enum
from dotenv import load_dotenv

load_dotenv()
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/biometry_health"#os.getenv("DATABASE_URL")

if not DATABASE_URL: 
    raise RuntimeError("DATABASE_URL не задан в переменных окружения .env")

class FaceMatchDecision(str, Enum):
    MATCH = "match"
    NO_MATCH = "no_match"
    MANUAL_REVIEW = "manual_review"
    INSUFFICIENT_QUALITY = "insufficient_quality"


class LivenessDecision(str, Enum):
    LIVE = "live"
    SPOOF_DETECTED = "spoof_detected"
    INCONCLUSIVE = "inconclusive"


class HealthIDCategory(str, Enum):
    GOOD = "good"
    WARNING = "warning"
    POOR = "poor"
    INSUFFICIENT_DATA = "insufficient_data"


@dataclass
class ModelConfig:
    # Face Match
    match_threshold: float = 0.85          # порог уверенного совпадения
    manual_review_threshold: float = 0.60  # порог ручной проверки
    max_frames_to_process: int = 120       # максимум обрабатываемых кадров
    frame_sample_interval: int = 5         # интервал выборки кадров
    min_detected_frames: int = 5           # минимальное число кадров с найденным лицом
    embedding_method: str = "hog_lbp"      # метод извлечения признаков лица комбинация HOG+LBP
    detector_backend: str = "haar"         # детектор лиц

    # Liveness
    liveness_pass: float = 0.70            # порог прохождения
    liveness_fail: float = 0.50            # порог провала
    blink_weight: float = 0.35             # вес признака моргание — главный признак живого человека
    head_motion_weight: float = 0.30       # Движение головы (повороты, наклоны)
    texture_weight: float = 0.25           # Текстурный анализ — отличие реальной кожи от фото/экрана
    depth_weight: float = 0.10             # Анализ глубины — есть ли 3D-структура лица — глубина отключена (0.10) для веб-камеры
    # Параметры признаков
    blink_min_count: int = 1               # минимум 1 моргание за видео. Мягкий критерий, уязвим к replay-атакам — лучше повысить до 2–3
    blink_min_ratio: float = 0.25          # глаз должен закрыться минимум на 25% от открытого состояния.
    head_motion_min_frames: int = 3        # минимум 3 кадра с изменением положения головы.
    texture_lbp_threshold: float = 0.45    #  порог LBP-текстуры: выше 0.45 — подозрение на подмену
    texture_freq_threshold: float = 0.40   # порог частотного анализа: ловит артефакты экрана (муар, пикселизация), которых нет на живой коже.
    depth_enabled: bool = False            # анализ глубины отключён. Для него нужна стереокамера или ToF-датчик, а доступна только веб-камера.
    # Параметры использования сиамских сетей
    liveness_method = "ensemble"            # "siamese" | "rppg" | "ensemble"
    liveness_strategy = "adaptive"          # "weighted_avg" | "and" | "or" | "adaptive"
    liveness_threshold = 0.5
    liveness_siamese_model_path = "models/siamese_liveness.pt"
    liveness_siamese_threshold = 0.5
    liveness_siamese_weight = 0.4
    liveness_rppg_min_confidence = 0.3
    liveness_rppg_weight = 0.6

    # Quality
    min_resolution: tuple = (480, 640)  # разрешение видео
    min_fps: int = 15                   # минимальная частота кадров: не менее 15 кадров в секунду
    min_duration_sec: float = 3.0       # минимальная длительность видео: не короче 3 секунд
    min_face_area_pct: float = 5.0      # средняя площадь лица на кадре
    max_blur_variance: float = 35.0     # максимальная вариация размытия (из‑за тряски камеры, расфокусировки или быстрого движения).
    max_yaw: float = 25.0               # максимальный поворот головы по горизонтали (yaw) не должен превышать 25 градусов.
    max_pitch: float = 20.0             # максимальный наклон головы вверх/вниз не более 20 градусов.
    max_roll: float = 15.0              # наклон головы в сторону
    max_occlusion_pct: float = 10.0     # максимальная доля перекрытия лица не должна превышать 10%.

    # rPPG
    # конфигурация модуля rPPG (remote Photoplethysmography) — бесконтактного измерения пульса и дыхания по видео. 
    # Технология улавливает микроскопические изменения цвета кожи, связанные с кровотоком, и по ним вычисляет сердечный ритм и частоту дыхания.
    # параметры захвата
    rppg_min_fps: float = 15.0      # минимальная частота кадров видео для rPPG не менее 15 fps.
    rppg_min_duration: float = 10.0 # минимальная длительность видео: не короче 10 секунд
    rppg_target_fps: int = 30       # целевая частота кадров для анализа: 30 fps.
    # Частотные полосы
    hr_band: tuple = (0.7, 3.0)     # полоса частот для heart rate (пульса): 0.7–3.0 Гц. Перевод в удары/минуту: 42–180 bpm. 
    br_band: tuple = (0.15, 0.5)    # полоса частот для heart rate (пульса): 0.7–3.0 Гц. Перевод в удары/минуту: 42–180 bpm.
    rppg_min_signal_quality: float = 0.3  # полоса частот для breathing rate (дыхания): 0.15–0.5 Гц. Перевод в циклы/минуту: 9–30 вдохов/мин.

    # HEALTH_ID
    # Веса компонентов health ID
    health_id_weights: dict = field(default_factory=lambda: {
        "heart_rate": 0.25,              # Пульс — основной витальный показатель
        "hrv": 0.20,                     # Вариабельность сердечного ритма — показатель адаптации нервной системы
        "breathing_rate": 0.15,          # Частота дыхания 
        "stress_index": 0.15,            # Индекс стресса (на основе HRV и других метрик)
        "signal_quality": 0.15,          # Качество сигнала rPPG — насколько данным можно доверять
        "verification_quality": 0.10,    # Качество верификации (освещение, ракурс, детекция лица)
    })
    # Пороги решения
    health_id_good: float = 0.80         # Score ≥ 0.80 → состояние хорошее, отклонений нет
    health_id_warning: float = 0.60      # 0.60–0.80 → предупреждение, возможны отклонения
    # Анализ аномалий (острые и хронические) 
    acute_z_threshold: float = 2.0       # порог Z-score для обнаружения острых отклонений.
    persistent_window: int = 3           # окно обнаружения острых аномалий: 3 последних измерения. 
    chronic_window: int = 10             # окно для хронических (длительных) трендов: 10 измерений
    chronic_slope_pct: float = 0.02      # минимальный наклон тренда для хронической аномалии: 2% за окно.
    min_history_for_corridor: int = 5    # минимум 5 измерений для построения «коридора нормы».

    # Пока накоплено менее 5 замеров, система не оценивает динамику — недостаточно данных для персональной нормы. 
    # После 5 измерений строится индивидуальный коридор (среднее ± стандартное отклонение), и последующие замеры сравниваются уже с ним.

    # Population fallback 
    # популяционные базовые значения
    pop_baseline: dict = field(default_factory=lambda: {
        "heart_rate": {"mean": 72.0, "std": 10.0},     # Нормальный пульс покоя
        "hrv": {"mean": 45.0, "std": 12.0},            # Условная вариабельность ритма 
        "breathing_rate": {"mean": 16.0, "std": 3.0},  # Норма дыхания
        "stress_index": {"mean": 0.35, "std": 0.15},   # Условный индекс стресса
    })

    # Review triggers
    # триггеров ручной проверки                
    review_trigger_acute: bool = True         # отправлять на ручную проверку при острых отклонениях.
    review_trigger_poor: bool = True          # отправлять при низком качестве данных
    review_trigger_persistent: bool = True    # отправлять при устойчивых отклонениях
    review_trigger_chronic: bool = True       # отправлять при хронических трендах
    review_trigger_manual: bool = True        # разрешать ручную инициацию проверки.

    # Drift detection
    # Параметры обнаружения
    drift_window_days: int = 7          # окно анализа: 7 дней.
    drift_psi_threshold: float = 0.25   # порог PSI
    drift_ks_pvalue: float = 0.05       # p‑value для критерия Колмогорова–Смирнова (KS‑тест)
    drift_min_samples: int = 20         # минимум 20 замеров в окне для анализа
    # Отслеживаемые метрики
    drift_metrics: list = field(default_factory=lambda: [
        "match_score", "liveness_score", "quality_score",
        "heart_rate", "hrv", "breathing_rate", "stress_index", "health_id_value",
    ])

    # Model identity
    model_version: str = "face_v1.0.0"

    def to_dict(self) -> dict:
        d = asdict(self)
        d["min_resolution"] = list(d["min_resolution"])
        d["hr_band"] = list(d["hr_band"])
        d["br_band"] = list(d["br_band"])
        return d

    @property
    def config_hash(self) -> str:
        raw = json.dumps(self.to_dict(), sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(raw.encode()).hexdigest()
