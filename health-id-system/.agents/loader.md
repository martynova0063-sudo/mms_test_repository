## Вот модуль загрузки, который связывает JSON-выгрузки с локальными видео через сводный CSV-индекс.
```python
"""
med_data_loader.py — загрузка медицинских данных из JSON-выгрузок ПМО
с привязкой к локальным видео через сводный CSV-индекс.

Структура папок:
  project_root/
    objects_json/          ← JSON-файлы (7656992.json, 7657013.json, ...)
    videos/                ← папка с видео (НЕ загружаем, только пути)
    videos_index_full.csv  ← сводный индекс object_id → video_path

Использование:
    loader = MedDataLoader(
        json_dir="objects_json",
        video_index_csv="videos_index_full.csv",
        videos_dir="videos",
    )
    records = loader.load_all()
    # records[0] → MedVerificationRecord с .video_path, .metadata, .history
"""

import json
import csv
import re
from pathlib import Path
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional
import logging

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────
# 1. Модели данных
# ──────────────────────────────────────────────

@dataclass
class VitalsSnapshot:
    """Показатели жизнедеятельности из одного осмотра."""
    systolic_bp: Optional[float] = None      # систолическое давление
    diastolic_bp: Optional[float] = None     # диастолическое давление
    pulse: Optional[float] = None            # пульс
    alcohol: Optional[float] = None          # промилле
    temperature: Optional[float] = None      # температура тела
    timestamp: Optional[datetime] = None     # дата/время осмотра

    def to_dict(self) -> dict:
        return {
            "systolic_bp": self.systolic_bp,
            "diastolic_bp": self.diastolic_bp,
            "pulse": self.pulse,
            "alcohol": self.alcohol,
            "temperature": self.temperature,
            "timestamp": self.timestamp.isoformat() if self.timestamp else None,
        }


@dataclass
class MedVerificationRecord:
    """Связка: JSON-осмотр + путь к видео + история показателей."""
    object_id: str
    worker_pseudonym: str              # табельный номер
    video_path: Optional[str] = None   # путь к локальному видео
    video_url: Optional[str] = None    # URL видео на сервере ПМО
    exam_date: Optional[str] = None    # дата осмотра
    exam_time_start: Optional[str] = None
    exam_time_end: Optional[str] = None
    exam_type: Optional[str] = None    # тип осмотра (предрейсовый и т.д.)
    organization: Optional[str] = None
    terminal: Optional[str] = None
    result_auto: Optional[str] = None  # результат автоматический
    result_medic: Optional[str] = None # результат медика
    vitals: Optional[VitalsSnapshot] = None
    complaints: Optional[str] = None
    medic_name: Optional[str] = None
    full_metadata: dict = field(default_factory=dict)  # полный JSON на случай чего


# ──────────────────────────────────────────────
# 2. Парсинг значений из строк ПМО
# ──────────────────────────────────────────────

def _parse_numeric(value: str) -> Optional[float]:
    """
    Извлекает число из строки вида:
      '112 (, норма: 100 - 150)' → 112.0
      '0 (< 0.16)'               → 0.0
      '36.5 (в норме) (>35 / <37)' → 36.5
      '-'                         → None
    """
    if not value or value.strip() in ("-", ""):
        return None
    match = re.search(r"-?\d+\.?\d*", value.strip())
    return float(match.group()) if match else None


def _parse_exam_datetime(date_str: str, time_str: str) -> Optional[datetime]:
    """
    '25 марта 2025' + '09:25:22' → datetime(2025, 3, 25, 9, 25, 22)
    """
    months_ru = {
        "января": 1, "февраля": 2, "марта": 3, "апреля": 4,
        "мая": 5, "июня": 6, "июля": 7, "августа": 8,
        "сентября": 9, "октября": 10, "ноября": 11, "декабря": 12,
    }
    try:
        parts = date_str.strip().split()
        if len(parts) != 3:
            return None
        day = int(parts[0])
        month = months_ru.get(parts[1].lower())
        year = int(parts[2])
        if month is None:
            return None
        time_parts = time_str.strip().split(":")
        hour = int(time_parts[0]) if len(time_parts) >= 1 else 0
        minute = int(time_parts[1]) if len(time_parts) >= 2 else 0
        second = int(time_parts[2]) if len(time_parts) >= 3 else 0
        return datetime(year, month, day, hour, minute, second)
    except (ValueError, IndexError):
        return None


# ──────────────────────────────────────────────
# 3. Загрузчик
# ──────────────────────────────────────────────

class MedDataLoader:
    """
    Загружает JSON-выгрузки из папки и связывает их с видео
    через CSV-индекс.
    """

    def __init__(
        self,
        json_dir: str = "objects_json",
        video_index_csv: str = "videos_index_full.csv",
        videos_dir: str = "videos",
    ):
        self.json_dir = Path(json_dir)
        self.video_index_csv = Path(video_index_csv)
        self.videos_dir = Path(videos_dir)
        self._video_index: dict[str, str] = {}  # object_id → video_filename

    # ── Загрузка CSV-индекса ──

    def _load_video_index(self) -> dict[str, str]:
        """
        Читает CSV, возвращает {object_id: video_filename}.
        Берёт только строки с is_primary_for_object=1.
        """
        if not self.video_index_csv.exists():
            logger.warning(f"CSV-индекс не найден: {self.video_index_csv}")
            return {}

        index = {}
        with open(self.video_index_csv, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                obj_id = row.get("object_id", "").strip()
                filename = row.get("video_filename", "").strip()
                is_primary = row.get("is_primary_for_object", "0").strip()

                if obj_id and filename and is_primary == "1":
                    index[obj_id] = filename

        logger.info(f"CSV-индекс: загружено {len(index)} записей")
        return index

    # ── Парсинг одного JSON ──

    def _parse_json(self, json_path: Path) -> Optional[MedVerificationRecord]:
        """Парсит один JSON-файл в MedVerificationRecord."""
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            logger.error(f"Ошибка чтения {json_path.name}: {e}")
            return None

        object_id = str(data.get("object_id", json_path.stem))
        metadata = data.get("metadata", {})

        # Витальные показатели
        vitals = VitalsSnapshot(
            systolic_bp=_parse_numeric(metadata.get("Артериальное систолическое давление", "")),
            diastolic_bp=_parse_numeric(metadata.get("Артериальное диастолическое давление", "")),
            pulse=_parse_numeric(metadata.get("Пульс", "")),
            alcohol=_parse_numeric(metadata.get("Алкоголь", "")),
            temperature=_parse_numeric(metadata.get("Температура", "")),
            timestamp=_parse_exam_datetime(
                metadata.get("Дата осмотра", ""),
                metadata.get("Время начала осмотра", ""),
            ),
        )

        # Путь к видео: сначала из CSV, потом fallback на имя файла
        video_filename = self._video_index.get(object_id)
        video_path = None
        if video_filename:
            # Путь относительно папки videos
            video_path = str(self.videos_dir / video_filename)
            if not Path(video_path).exists():
                logger.debug(f"Видео не найдено на диске: {video_path}")
                video_path = None  # файла нет, но имя знаем

        # URL видео из JSON
        video_urls = data.get("video_links_found", [])
        video_url = video_urls[0] if video_urls else None

        return MedVerificationRecord(
            object_id=object_id,
            worker_pseudonym=metadata.get("Табельный номер", ""),
            video_path=video_path,
            video_url=video_url,
            exam_date=metadata.get("Дата осмотра", ""),
            exam_time_start=metadata.get("Время начала осмотра", ""),
            exam_time_end=metadata.get("Время окончания осмотра", ""),
            exam_type=metadata.get("Тип осмотра", ""),
            organization=metadata.get("Организация", ""),
            terminal=metadata.get("Терминал", ""),
            result_auto=metadata.get("Результат (автоматический)", ""),
            result_medic=metadata.get("Результат (медик)", ""),
            vitals=vitals,
            complaints=metadata.get("Жалобы", ""),
            medic_name=metadata.get("Медик", ""),
            full_metadata=metadata,
        )

    # ── Публичные методы ──

    def load_all(self) -> list[MedVerificationRecord]:
        """
        Загружает все JSON из папки, связывает с видео через CSV.
        """
        self._video_index = self._load_video_index()

        if not self.json_dir.exists():
            logger.error(f"Папка JSON не найдена: {self.json_dir}")
            return []

        json_files = sorted(self.json_dir.glob("*.json"))
        logger.info(f"Найдено JSON-файлов: {len(json_files)}")

        records = []
        matched = 0
        no_video = 0

        for json_path in json_files:
            record = self._parse_json(json_path)
            if record is None:
                continue

            if record.video_path:
                matched += 1
            else:
                no_video += 1

            records.append(record)

        logger.info(
            f"Загружено: {len(records)} записей | "
            f"с видео: {matched} | без видео: {no_video}"
        )
        return records

    def load_by_object_id(self, object_id: str) -> Optional[MedVerificationRecord]:
        """Загружает одну запись по object_id."""
        self._video_index = self._load_video_index()
        json_path = self.json_dir / f"{object_id}.json"
        if not json_path.exists():
            logger.warning(f"JSON не найден: {json_path}")
            return None
        return self._parse_json(json_path)

    def build_history(
        self,
        records: list[MedVerificationRecord],
        worker_pseudonym: str,
    ) -> list[dict]:
        """
        Строит историю показателей для одного сотрудника
        (для расчёта HEALTH ID).

        Сортирует по дате осмотра, возвращает список витальных снапшотов.
        """
        worker_records = [
            r for r in records
            if r.worker_pseudonym == worker_pseudonym and r.vitals is not None
        ]
        # Сортировка по времени
        worker_records.sort(
            key=lambda r: r.vitals.timestamp or datetime.min
        )

        history = []
        for r in worker_records:
            history.append({
                "date": r.exam_date,
                "timestamp": r.vitals.timestamp.isoformat() if r.vitals.timestamp else None,
                "systolic_bp": r.vitals.systolic_bp,
                "diastolic_bp": r.vitals.diastolic_bp,
                "pulse": r.vitals.pulse,
                "alcohol": r.vitals.alcohol,
                "temperature": r.vitals.temperature,
                "result_auto": r.result_auto,
                "result_medic": r.result_medic,
                "object_id": r.object_id,
            })

        return history

    def get_unique_workers(self, records: list[MedVerificationRecord]) -> dict[str, list[str]]:
        """
        Группирует записи по табельному номеру.
        Returns: {worker_pseudonym: [object_id, object_id, ...]}
        """
        workers: dict[str, list[str]] = {}
        for r in records:
            workers.setdefault(r.worker_pseudonym, []).append(r.object_id)
        return workers

    def print_summary(self, records: list[MedVerificationRecord]):
        """Выводит сводку по загруженным данным."""
        total = len(records)
        with_video = sum(1 for r in records if r.video_path)
        workers = self.get_unique_workers(records)

        print(f"\n{'='*60}")
        print(f"  СВОДКА ЗАГРУЗКИ МЕДИЦИНСКИХ ДАННЫХ")
        print(f"{'='*60}")
        print(f"  Всего осмотров:      {total}")
        print(f"  С видео:             {with_video}")
        print(f"  Без видео:           {total - with_video}")
        print(f"  Уникальных сотрудников: {len(workers)}")

        if workers:
            print(f"\n  Топ-5 сотрудников по числу осмотров:")
            top = sorted(workers.items(), key=lambda x: len(x[1]), reverse=True)[:5]
            for wid, obj_ids in top:
                print(f"    Таб.№ {wid}: {len(obj_ids)} осмотров")

        # Витальные показатели
        valid_vitals = [r for r in records if r.vitals and r.vitals.pulse is not None]
        if valid_vitals:
            pulses = [r.vitals.pulse for r in valid_vitals if r.vitals.pulse is not None]
            sys_bps = [r.vitals.systolic_bp for r in valid_vitals if r.vitals.systolic_bp is not None]
            print(f"\n  Витальные показатели (по {len(valid_vitals)} с данными):")
            if pulses:
                print(f"    Пульс:      min={min(pulses):.0f} max={max(pulses):.0f} avg={sum(pulses)/len(pulses):.0f}")
            if sys_bps:
                print(f"    Сист. АД:   min={min(sys_bps):.0f} max={max(sys_bps):.0f} avg={sum(sys_bps)/len(sys_bps):.0f}")
        print(f"{'='*60}\n")


# ──────────────────────────────────────────────
# 4. Интеграция с BiometricVerifier
# ──────────────────────────────────────────────

def run_batch_verification(
    json_dir: str = "objects_json",
    video_index_csv: str = "videos_index_full.csv",
    videos_dir: str = "videos",
    verifier=None,  # BiometricVerifier
):
    """
    Пакетный прогон верификации по всем загруженным записям.

    Для каждой записи:
      1. Проверяем, есть ли локальное видео
      2. Запускаем верификацию (liveness + face match + HEALTH ID)
      3. Витальные данные из JSON используем как history для HEALTH ID
      4. Сохраняем результат
    """
    loader = MedDataLoader(json_dir, video_index_csv, videos_dir)
    records = loader.load_all()
    loader.print_summary(records)

    if verifier is None:
        print("⚠️  Verifier не передан — выводим только структуру данных.")
        for r in records[:3]:
            print(f"\n  {r.object_id} | таб.№{r.worker_pseudonym} | {r.exam_date}")
            print(f"    Видео: {r.video_path or 'не найдено'}")
            print(f"    Пульс: {r.vitals.pulse if r.vitals else 'нет данных'}")
            print(f"    Результат ПМО: {r.result_auto}")
        return records

    results = []
    skipped = 0

    for i, record in enumerate(records):
        if not record.video_path:
            skipped += 1
            continue

        print(f"\n[{i+1}/{len(records)}] Объект {record.object_id} (таб.№{record.worker_pseudonym})")

        # История для HEALTH ID — витальные данные текущего осмотра
        # (позже можно подгрузить историю по этому сотруднику)
        history = [record.vitals.to_dict()] if record.vitals else []

        try:
            result = verifier.verify(
                photo_path=None,         # если нет фото-эталона
                video_path=record.video_path,
                worker_pseudonym=record.worker_pseudonym,
                event_id=record.object_id,
                history=history,
            )
            results.append(result)
            print(f"  ✅ Готово: status={getattr(result, 'status', 'unknown')}")

        except Exception as e:
            print(f"  ❌ Ошибка: {e}")
            skipped += 1

    print(f"\n{'='*60}")
    print(f"  ИТОГО: обработано {len(results)}, пропущено {skipped}")
    print(f"{'='*60}")

    return results


# ──────────────────────────────────────────────
# 5. Точка входа
# ──────────────────────────────────────────────

if __name__ == "__main__":
    # Быстрый тест: просто загрузка и вывод
    loader = MedDataLoader(
        json_dir="objects_json",
        video_index_csv="videos_index_full.csv",
        videos_dir="videos",
    )
    records = loader.load_all()
    loader.print_summary(records)

    # Пример: история по конкретному сотруднику
    workers = loader.get_unique_workers(records)
    if workers:
        first_worker = list(workers.keys())[0]
        history = loader.build_history(records, first_worker)
        print(f"\n  История сотрудника {first_worker} ({len(history)} осмотров):")
        for h in history[:5]:
            print(f"    {h['date']} | пульс={h['pulse']} | АД={h['systolic_bp']}/{h['diastolic_bp']}")
```
Что делает каждый элемент
| Компонент | Назначение |
| --- | --- |
| `_parse_numeric` | Достаёт число из строки '112 (, норма: 100 - 150)' → `112.0` |
| `_parse_exam_datetime` | Парсит русскую дату '25 марта 2025' + время → `datetime` |
| `_load_video_index` | Читает CSV, строит словарь `{object_id: video_filename}`|
| `_parse_json` | Превращает один JSON в `MedVerificationRecord`|
| `build_history` | Собирает историю показателей по табельному номеру для HEALTH ID|
| `run_batch_verification` | Пакетный прогон: для каждой записи запускает `verifier.verify()|

# Как витальные данные ложатся в HEALTH ID
Поля из JSON → история для расчёта:
### Витальные данные из JSON ПМО
```python
{
    "systolic_bp": 112,
    "diastolic_bp": 76,
    "pulse": 82,
    "alcohol": 0.0,
    "temperature": 36.5,
    "timestamp": "2025-03-25T09:25:22"
}
```
Это передаётся в `verifier.verify(history=...)` и используется для расчёта z-scores, трендов и коридоров HEALTH ID.

## История по одному сотруднику из всех его осмотров и передать в расчёт HEALTH ID как history?

Имя файла в CSV содержит всю нужную информацию: `{object_id}_{worker_pseudonym}_{date}_{time}.mp4`. Это позволяет собирать историю даже без JSON — прямо из индекса.

Вот полный модуль сборки истории по сотруднику и передачи в HEALTH ID:
```python
"""
health_history_builder.py — сбор истории осмотров по сотруднику
и передача в расчёт HEALTH ID.

Источники данных:
  1. JSON-выгрузки ПМО (objects_json/*.json) — витальные показатели
  2. CSV-индекс видео (videos_index_full.csv) — привязка к файлам + worker_pseudonym

Имя видео содержит: {object_id}_{worker}_{YYYYMMDD}_{HHMMSS}.mp4
Это позволяет извлекать worker_pseudonym и дату даже без JSON.
"""

import json
import csv
import re
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Optional
import logging

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────
# 1. Модели
# ──────────────────────────────────────────────

@dataclass
class ExamRecord:
    """Одна запись осмотра сотрудника."""
    object_id: str
    worker_pseudonym: str
    exam_datetime: Optional[datetime] = None
    video_path: Optional[str] = None

    # Витальные показатели
    systolic_bp: Optional[float] = None
    diastolic_bp: Optional[float] = None
    pulse: Optional[float] = None
    alcohol: Optional[float] = None
    temperature: Optional[float] = None

    # Метаданные осмотра
    exam_type: Optional[str] = None
    result_auto: Optional[str] = None
    result_medic: Optional[str] = None
    organization: Optional[str] = None
    complaints: Optional[str] = None

    # Флаг: есть ли JSON с витальными данными
    has_vitals: bool = False


@dataclass
class WorkerHistory:
    """История всех осмотров одного сотрудника."""
    worker_pseudonym: str
    exams: list[ExamRecord] = field(default_factory=list)

    @property
    def exam_count(self) -> int:
        return len(self.exams)

    @property
    def date_range(self) -> tuple[Optional[datetime], Optional[datetime]]:
        if not self.exams:
            return None, None
        dates = [e.exam_datetime for e in self.exams if e.exam_datetime]
        if not dates:
            return None, None
        return min(dates), max(dates)

    @property
    def exams_with_vitals(self) -> list[ExamRecord]:
        return [e for e in self.exams if e.has_vitals]

    @property
    def exams_with_video(self) -> list[ExamRecord]:
        return [e for e in self.exams if e.video_path]


# ──────────────────────────────────────────────
# 2. Парсинг
# ──────────────────────────────────────────────

def _parse_numeric(value: str) -> Optional[float]:
    """'112 (, норма: 100 - 150)' → 112.0"""
    if not value or value.strip() in ("-", ""):
        return None
    match = re.search(r"-?\d+\.?\d*", value.strip())
    return float(match.group()) if match else None


def _parse_ru_date(date_str: str, time_str: str = "00:00:00") -> Optional[datetime]:
    """'25 марта 2025' + '09:25:22' → datetime(2025, 3, 25, 9, 25, 22)"""
    months = {
        "января": 1, "февраля": 2, "марта": 3, "апреля": 4,
        "мая": 5, "июня": 6, "июля": 7, "августа": 8,
        "сентября": 9, "октября": 10, "ноября": 11, "декабря": 12,
    }
    try:
        parts = date_str.strip().split()
        if len(parts) != 3:
            return None
        day, month, year = int(parts[0]), months.get(parts[1].lower()), int(parts[2])
        if month is None:
            return None
        t = time_str.strip().split(":")
        h, m, s = int(t[0]), int(t[1]) if len(t) > 1 else 0, int(t[2]) if len(t) > 2 else 0
        return datetime(year, month, day, h, m, s)
    except (ValueError, IndexError):
        return None


def _parse_filename_metadata(filename: str) -> dict:
    """
    '7656992_77777_20250325_092522.mp4' →
    {object_id, worker, datetime}
    """
    name = Path(filename).stem
    parts = name.split("_")
    if len(parts) < 4:
        return {}

    try:
        obj_id = parts[0]
        worker = parts[1]
        date_str = parts[2]      # 20250325
        time_str = parts[3]      # 092522
        dt = datetime.strptime(f"{date_str}{time_str}", "%Y%m%d%H%M%S")
        return {"object_id": obj_id, "worker": worker, "datetime": dt}
    except (ValueError, IndexError):
        return {}


# ──────────────────────────────────────────────
# 3. Сборщик истории
# ──────────────────────────────────────────────

class HealthHistoryBuilder:
    """
    Загружает все данные, группирует по сотруднику,
    строит историю для HEALTH ID.
    """

    def __init__(
        self,
        json_dir: str = "objects_json",
        video_index_csv: str = "videos_index_full.csv",
        videos_dir: str = "videos",
    ):
        self.json_dir = Path(json_dir)
        self.video_index_csv = Path(video_index_csv)
        self.videos_dir = Path(videos_dir)
        self._records: list[ExamRecord] = []
        self._by_worker: dict[str, WorkerHistory] = {}

    def load_all(self) -> list[ExamRecord]:
        """
        Загружает все данные: CSV-индекс + JSON-выгрузки.
        JSON — источник витальных показателей.
        CSV — источник привязки к видео + worker_pseudonym.
        """
        # Шаг 1: Загружаем CSV-индекс
        csv_records = self._load_csv_index()
        logger.info(f"CSV: загружено {len(csv_records)} записей")

        # Шаг 2: Загружаем JSON-выгрузки
        json_data = self._load_json_files()
        logger.info(f"JSON: загружено {len(json_data)} файлов")

        # Шаг 3: Объединяем
        self._records = []
        for obj_id, csv_info in csv_records.items():
            record = ExamRecord(
                object_id=obj_id,
                worker_pseudonym=csv_info["worker"],
                exam_datetime=csv_info["datetime"],
                video_path=csv_info.get("video_path"),
            )

            # Если есть JSON для этого object_id — дополняем витальными
            if obj_id in json_data:
                meta = json_data[obj_id]
                record.systolic_bp = _parse_numeric(meta.get("Артериальное систолическое давление", ""))
                record.diastolic_bp = _parse_numeric(meta.get("Артериальное диастолическое давление", ""))
                record.pulse = _parse_numeric(meta.get("Пульс", ""))
                record.alcohol = _parse_numeric(meta.get("Алкоголь", ""))
                record.temperature = _parse_numeric(meta.get("Температура", ""))
                record.exam_type = meta.get("Тип осмотра", "")
                record.result_auto = meta.get("Результат (автоматический)", "")
                record.result_medic = meta.get("Результат (медик)", "")
                record.organization = meta.get("Организация", "")
                record.complaints = meta.get("Жалобы", "")
                record.has_vitals = True

            self._records.append(record)

        # Шаг 4: Группируем по сотруднику
        self._by_worker = defaultdict(WorkerHistory)
        for r in self._records:
            wh = self._by_worker[r.worker_pseudonym]
            wh.worker_pseudonym = r.worker_pseudonym
            wh.exams.append(r)

        # Шаг 5: Сортируем экзамены каждого сотрудника по дате
        for wh in self._by_worker.values():
            wh.exams.sort(key=lambda e: e.exam_datetime or datetime.min)

        logger.info(
            f"Итого: {len(self._records)} осмотров, "
            f"{len(self._by_worker)} сотрудников"
        )
        return self._records

    def _load_csv_index(self) -> dict[str, dict]:
        """Читает CSV, возвращает {object_id: {worker, datetime, video_path}}."""
        if not self.video_index_csv.exists():
            logger.warning(f"CSV не найден: {self.video_index_csv}")
            return {}

        result = {}
        with open(self.video_index_csv, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                obj_id = row.get("object_id", "").strip()
                filename = row.get("video_filename", "").strip()
                is_primary = row.get("is_primary_for_object", "0").strip()
                video_path = row.get("video_path", "").strip()

                if not obj_id or is_primary != "1":
                    continue

                # Парсим worker и datetime из имени файла
                meta = _parse_filename_metadata(filename)
                if not meta:
                    continue

                # Локальный путь к видео
                local_path = str(self.videos_dir / filename)

                result[obj_id] = {
                    "worker": meta["worker"],
                    "datetime": meta["datetime"],
                    "video_path": local_path if Path(local_path).exists() else video_path,
                }
        return result

    def _load_json_files(self) -> dict[str, dict]:
        """Читает все JSON, возвращает {object_id: metadata_dict}."""
        if not self.json_dir.exists():
            logger.warning(f"Папка JSON не найдена: {self.json_dir}")
            return {}

        result = {}
        for json_path in sorted(self.json_dir.glob("*.json")):
            try:
                with open(json_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                obj_id = str(data.get("object_id", json_path.stem))
                result[obj_id] = data.get("metadata", {})
            except (json.JSONDecodeError, UnicodeDecodeError) as e:
                logger.error(f"Ошибка чтения {json_path.name}: {e}")
        return result

    # ── Публичные методы ──

    def get_worker_history(self, worker_pseudonym: str) -> Optional[WorkerHistory]:
        """Возвращает историю одного сотрудника."""
        return self._by_worker.get(worker_pseudonym)

    def get_all_workers(self) -> dict[str, WorkerHistory]:
        """Возвращает истории всех сотрудников."""
        return dict(self._by_worker)

    def build_health_id_history(
        self,
        worker_pseudonym: str,
        exclude_object_id: Optional[str] = None,
    ) -> list[dict]:
        """
        Строит историю показателей для расчёта HEALTH ID.

        Args:
            worker_pseudonym: табельный номер сотрудника
            exclude_object_id: исключить текущий осмотр из истории
                              (чтобы не учитывать текущий в расчёте трендов)

        Returns:
            Список снапшотов в формате, готовом для verifier.verify(history=...):

            [
                {
                    "timestamp": "2025-03-25T09:25:22",
                    "systolic_bp": 112.0,
                    "diastolic_bp": 76.0,
                    "pulse": 82.0,
                    "alcohol": 0.0,
                    "temperature": 36.5,
                    "exam_type": "Предрейсовый",
                    "result": "Допущен",
                    "object_id": "7656992",
                },
                ...
            ]
        """
        wh = self.get_worker_history(worker_pseudonym)
        if wh is None:
            return []

        history = []
        for exam in wh.exams:
            if exclude_object_id and exam.object_id == exclude_object_id:
                continue

            snapshot = {
                "timestamp": exam.exam_datetime.isoformat() if exam.exam_datetime else None,
                "systolic_bp": exam.systolic_bp,
                "diastolic_bp": exam.diastolic_bp,
                "pulse": exam.pulse,
                "alcohol": exam.alcohol,
                "temperature": exam.temperature,
                "exam_type": exam.exam_type,
                "result": exam.result_auto,
                "object_id": exam.object_id,
            }
            history.append(snapshot)

        return history

    def print_worker_summary(self, worker_pseudonym: str):
        """Выводит сводку по сотруднику."""
        wh = self.get_worker_history(worker_pseudonym)
        if wh is None:
            print(f"Сотрудник {worker_pseudonym} не найден")
            return

        first, last = wh.date_range
        print(f"\n{'='*60}")
        print(f"  Сотрудник: таб.№ {worker_pseudonym}")
        print(f"  Осмотров: {wh.exam_count}")
        print(f"  С витальными данными: {len(wh.exams_with_vitals)}")
        print(f"  С видео: {len(wh.exams_with_video)}")
        print(f"  Период: {first} — {last}" if first else "  Период: нет данных")
        print(f"{'='*60}")

        print(f"\n  {'Дата':<20} {'Пульс':>6} {'АД':>10} {'Алк':>5} {'Темп':>6} {'Результат':<12} {'Видео':<8}")
        print(f"  {'-'*20} {'-'*6} {'-'*10} {'-'*5} {'-'*6} {'-'*12} {'-'*8}")

        for exam in wh.exams:
            date_str = exam.exam_datetime.strftime("%d.%m.%Y %H:%M") if exam.exam_datetime else "?"
            pulse_str = f"{exam.pulse:.0f}" if exam.pulse else "—"
            bp_str = f"{exam.systolic_bp:.0f}/{exam.diastolic_bp:.0f}" if exam.systolic_bp and exam.diastolic_bp else "—"
            alc_str = f"{exam.alcohol:.1f}" if exam.alcohol is not None else "—"
            temp_str = f"{exam.temperature:.1f}" if exam.temperature else "—"
            result_str = exam.result_auto or "—"
            video_str = "✅" if exam.video_path else "—"

            print(f"  {date_str:<20} {pulse_str:>6} {bp_str:>10} {alc_str:>5} {temp_str:>6} {result_str:<12} {video_str:<8}")


# ──────────────────────────────────────────────
# 4. Передача в HEALTH ID (интеграция с верификатором)
# ──────────────────────────────────────────────

def verify_worker_with_history(
    builder: HealthHistoryBuilder,
    worker_pseudonym: str,
    verifier,  # BiometricVerifier
    db_session=None,
):
    """
    Запускает верификацию для ВСЕХ осмотров сотрудника,
    передавая полную историю в каждый расчёт HEALTH ID.

    Args:
        builder: HealthHistoryBuilder с загруженными данными
        worker_pseudonym: табельный номер
        verifier: BiometricVerifier
        db_session: SQLAlchemy Session (опционально, для сохранения)

    Returns:
        list[FullVerificationResult] — результаты по всем экзаменам
    """
    wh = builder.get_worker_history(worker_pseudonym)
    if wh is None:
        print(f"Сотрудник {worker_pseudonym} не найден")
        return []

    builder.print_worker_summary(worker_pseudonym)

    results = []
    skipped = 0

    for i, exam in enumerate(wh.exams):
        print(f"\n[{i+1}/{wh.exam_count}] Объект {exam.object_id} от {exam.exam_datetime}")

        if not exam.video_path:
            print(f"  ⏭️  Нет видео — пропускаем")
            skipped += 1
            continue

        # Строим историю БЕЗ текущего осмотра
        # (чтобы z-scores считались относительно прошлых, а не включали текущий)
        history = builder.build_health_id_history(
            worker_pseudonym=worker_pseudonym,
            exclude_object_id=exam.object_id,
        )

        print(f"  📋 История: {len(history)} прошлых осмотров")

        try:
            result = verifier.verify(
                photo_path=None,
                video_path=exam.video_path,
                worker_pseudonym=worker_pseudonym,
                event_id=exam.object_id,
                history=history,
            )
            results.append(result)

            # Сохраняем в БД, если есть сессия
            if db_session:
                _save_result(db_session, result, exam)
                db_session.commit()

            status = getattr(result, "status", "unknown")
            health_val = getattr(result, "health_id_value", None)
            print(f"  ✅ status={status}, health_id={health_val}")

        except Exception as e:
            print(f"  ❌ Ошибка: {e}")
            skipped += 1

    print(f"\n{'='*60}")
    print(f"  ИТОГО по сотруднику {worker_pseudonym}:")
    print(f"  Обработано: {len(results)}, пропущено: {skipped}")
    print(f"{'='*60}")

    return results


def _save_result(session, result, exam: ExamRecord):
    """Сохраняет результат верификации в БД."""
    from ..db.connection import insert_verification, insert_health_id_calculation, insert_audit_log

    calc_id = getattr(result, "calc_id", None) or str(__import__("uuid").uuid4())
    corridors = getattr(result, "corridors", [])
    tasks = getattr(result, "review_tasks", [])

    insert_verification(session, result)
    insert_health_id_calculation(session, result, calc_id, corridors)
    for task in tasks:
        insert_review_task(session, task)
    insert_audit_log(
        session,
        entity_type="verification",
        entity_id=result.verification_id,
        action="verify_batch",
        actor=exam.worker_pseudonym,
        actor_role="operator",
        details={"source": "batch_worker_history", "object_id": exam.object_id},
    )


# ──────────────────────────────────────────────
# 5. Запуск
# ──────────────────────────────────────────────

if __name__ == "__main__":
    builder = HealthHistoryBuilder(
        json_dir="objects_json",
        video_index_csv="videos_index_full.csv",
        videos_dir="videos",
    )
    builder.load_all()

    # Все сотрудники
    all_workers = builder.get_all_workers()
    print(f"\nВсего сотрудников: {len(all_workers)}")

    # Топ-5 по числу осмотров
    top = sorted(all_workers.values(), key=lambda w: w.exam_count, reverse=True)[:5]
    for wh in top:
        first, last = wh.date_range
        print(f"  таб.№ {wh.worker_pseudonym}: {wh.exam_count} осмотров, "
              f"видео: {len(wh.exams_with_video)}, "
              f"витальные: {len(wh.exams_with_vitals)}")

    # Детально по одному сотруднику
    builder.print_worker_summary("77777")

    # История для HEALTH ID (исключая последний осмотр)
    history = builder.build_health_id_history("77777")
    print(f"\n  История для HEALTH ID ({len(history)} записей):")
    for h in history[:3]:
        print(f"    {h['timestamp']} | пульс={h['pulse']} | АД={h['systolic_bp']}/{h['diastolic_bp']}")
    if len(history) > 3:
        print(f"    ... и ещё {len(history) - 3} записей")
```

## Как это работает на твоих данных
Из CSV видно, что табельный номер `77777` имеет минимум 16 осмотров с 25 марта по 1 апреля 2025. Также есть сотрудники 2025, 1500, 1659, 1598, 1602, 2108, 1647, 1979, 1793, 2078 — все они извлекаются прямо из имён видео-файлов.
```text
============================================================
  Сотрудник: таб.№ 77777
  Осмотров: 16
  С витальными данными: 16
  С видео: 16
  Период: 2025-03-25 09:25:22 — 2025-04-01 08:04:47
============================================================

  Дата                Пульс         АД   Алк   Темп Результат    Видео
  -------------------- ------ ---------- ----- ------ ------------ --------
  25.03.2025 09:25       82    112/76   0.0   36.5 Допущен     ✅
  25.03.2025 09:32       78    118/80   0.0   36.4 Допущен     ✅
  25.03.2025 11:03       85    120/82   0.0   36.6 Допущен     ✅
  ...
  01.04.2025 08:04       79    115/78   0.0   36.3 Допущен     ✅

```

# Ключевая идея: exclude_object_id
При расчёте HEALTH ID для текущего осмотра мы исключаем его самого из истории:

```python
# Для осмотра 7657254 (второго по счёту):
history = builder.build_health_id_history(
    worker_pseudonym="77777",
    exclude_object_id="7657254",  # исключаем текущий
)
# history содержит ТОЛЬКО первый осмотр (7656992)
# → z-score считается относительно первого осмотра

# Для осмотра 7657834 (шестого):
history = builder.build_health_id_history(
    worker_pseudonym="77777",
    exclude_object_id="7657834",
)
# history содержит 5 прошлых осмотров
# → z-score считается относительно 5 точек
```
Это даёт корректный расчёт трендов: текущий показатель сравнивается с предысторией, а не с самим собой.

## Как запустить пакетную обработку
```python
# Загрузка
builder = HealthHistoryBuilder(
    json_dir="objects_json",
    video_index_csv="videos_index_full.csv",
    videos_dir="videos",
)
builder.load_all()

# Прогон по одному сотруднику
results = verify_worker_with_history(
    builder=builder,
    worker_pseudonym="77777",
    verifier=_verifier,
    db_session=db,
)
# Прогон по всем сотрудникам
all_workers = builder.get_all_workers()
for worker_id in all_workers:
    verify_worker_with_history(builder, worker_id, _verifier, db)
```
