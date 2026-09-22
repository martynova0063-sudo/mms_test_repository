"""
scripts/import_media_csv.py

Импорт манифеста медиафайлов ПАК в БД.
Вычисляет SHA-256 для каждого файла, если файл доступен локально.

Запуск:
    python scripts/import_media_csv.py \
        --csv pak-media-files-20260909.csv \
        --media-root /path/to/media \
        --db-url sqlite:///health_id.db

Если --media-root не указан, хеши не вычисляются (файлы недоступны).
Если --db-url не указан, используется SQLite по умолчанию.
"""

import argparse
import csv
import hashlib
import re
import sys
import uuid
from datetime import datetime
from pathlib import Path

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session


# ---------------------------------------------------------------------------
# Регулярное выражение для разбора пути
# ---------------------------------------------------------------------------
# Формат (Windows, обратные слеши):
#   photos\2026\08\28\<employeeUuid>\<eventUuid>_photo.jpg
#   videos\2026\08\19\<employeeUuid>\medpmo-video-test-9297865_video.mp4
#
# Группы:
#   1 — тип папки (photos / videos)
#   2-4 — год, месяц, день
#   5   — employee UUID
#   6   — event UUID или произвольный идентификатор
#   7   — имя файла целиком (event_id + _photo.jpg / _video.mp4)
# ---------------------------------------------------------------------------


PATH_RE = re.compile(
    r"^(photos|videos)[\\/](\d{4})[\\/](\d{2})[\\/](\d{2})[\\/]"
    r"([0-9a-fA-F-]{36})[\\/]"
    r"(.+?)_(photo\.jpg|video\.mp4)$",
    re.IGNORECASE,
)


def parse_path(relative_path: str) -> dict | None:
    """
    Разбирает относительный путь и извлекает компоненты.

    Возвращает dict с ключами:
        media_type, exam_date, employee_uuid, event_uuid, file_name
    или None, если путь не соответствует формату.
    """
    match = PATH_RE.match(relative_path)
    if not match:
        return None

    media_folder, year, month, day, employee_uuid, event_id, file_name = match.groups()

    return {
        "media_type": "photo" if media_folder == "photos" else "video",
        "exam_date": datetime(int(year), int(month), int(day)),
        "employee_uuid": employee_uuid,
        "event_uuid": event_id,
        "file_name": f"{event_id}_{file_name}",
    }


# ---------------------------------------------------------------------------
# Вычисление SHA-256
# ---------------------------------------------------------------------------

def compute_sha256(file_path: Path) -> str | None:
    """Вычисляет SHA-256 файла, если он существует."""
    if not file_path.exists() or not file_path.is_file():
        return None

    h = hashlib.sha256()
    try:
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                h.update(chunk)
        return h.hexdigest()
    except (OSError, PermissionError) as e:
        print(f"  ⚠️ Ошибка чтения {file_path}: {e}")
        return None


# ---------------------------------------------------------------------------
# Разбор LastWriteTime
# ---------------------------------------------------------------------------

def parse_timestamp(raw: str) -> datetime:
    """
    Разбирает timestamp из CSV.
    Формат: 2026-09-09T00:59:40
    """
    # Нормализуем: заменяем T на пробел для fromisoformat в Python < 3.11
    clean = raw.strip().replace("T", " ")
    return datetime.fromisoformat(clean)


# ---------------------------------------------------------------------------
# Разрешение локального пути
# ---------------------------------------------------------------------------

def resolve_local_path(media_root: str | None, relative_path: str) -> Path | None:
    """
    Пробует найти файл на диске, учитывая что CSV хранит пути
    с обратными слешами (Windows), а Replit работает на Linux.
    """
    if media_root is None:
        return None

    # Вариант 1: прямой путь как в CSV (Windows-стиль на Linux не сработает,
    # но если файлы залили как есть — попробуем)
    p1 = Path(media_root) / relative_path
    if p1.exists():
        return p1

    # Вариант 2: заменяем обратные слеши на прямые
    posix_path = relative_path.replace("\\", "/")
    p2 = Path(media_root) / posix_path
    if p2.exists():
        return p2

    return None


# ---------------------------------------------------------------------------
# Основная функция импорта
# ---------------------------------------------------------------------------

def import_csv(csv_path: str, media_root: str | None, db_url: str):
    """
    Читает CSV-манифест и импортирует записи в таблицу media_registry.

    Args:
        csv_path:   путь к CSV-файлу
        media_root: корневая папка с медиа (или None, если файлы недоступны)
        db_url:     URL подключения к БД
    """
    # Импортируем модель (внешний, чтобы скрипт можно было запускать автономно)
    try:
        from app.db.models import Base, MediaRegistry
    except ImportError:
        # Fallback — определяем минимальную модель прямо здесь
        from sqlalchemy import (
            Column, String, Integer, DateTime, Boolean, Index,
        )
        from sqlalchemy.orm import DeclarativeBase

        class Base(DeclarativeBase):
            pass

        class MediaRegistry(Base):
            __tablename__ = "media_registry"
            id = Column(String(36), primary_key=True)
            employee_uuid = Column(String(36), nullable=False, index=True)
            event_uuid = Column(String(256), nullable=False, index=True)
            media_type = Column(String(10), nullable=False, index=True)
            relative_path = Column(String(512), nullable=False)
            file_name = Column(String(256), nullable=False)
            size_bytes = Column(Integer, nullable=False)
            sha256_hash = Column(String(64), nullable=True)
            exam_date = Column(DateTime, nullable=False)
            stored_locally = Column(Boolean, default=False)
            last_write_time = Column(DateTime, nullable=False)
            created_at = Column(DateTime, nullable=False)
    # Создаём движок и таблицы
    engine = create_engine(db_url)
    Base.metadata.create_all(engine)

    # Статистика
    stats = {
        "total": 0,
        "imported": 0,
        "skipped_dup": 0,
        "skipped_parse": 0,
        "hashes_computed": 0,
        "hashes_missing": 0,
        "photos": 0,
        "videos": 0,
        "employees": set(),
    }

    with Session(engine) as session, open(csv_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)

        for row in reader:
            stats["total"] += 1
            rel_path = row["RelativePath"]

            # 1. Разбор пути
            parsed = parse_path(rel_path)
            if not parsed:
                print(f"  ⚠️ Пропущен (неподходящий формат): {rel_path}")
                stats["skipped_parse"] += 1
                continue

            # 2. Проверка дубликата по (event_uuid, media_type)
            existing = session.execute(
                select(MediaRegistry).where(
                    MediaRegistry.event_uuid == parsed["event_uuid"],
                    MediaRegistry.media_type == parsed["media_type"],
                )
            ).scalar_one_or_none()

            if existing:
                stats["skipped_dup"] += 1
                continue

            # 3. Поиск файла и вычисление SHA-256
            local_path = resolve_local_path(media_root, rel_path)
            sha256 = compute_sha256(local_path) if local_path else None
            stored_locally = local_path is not None and local_path.exists()

            if sha256:
                stats["hashes_computed"] += 1
            else:
                stats["hashes_missing"] += 1

            # 4. Разбор timestamp
            try:
                last_write = parse_timestamp(row["LastWriteTime"])
            except (ValueError, KeyError):
                last_write = datetime.now()

            # 5. Создание записи
            record = MediaRegistry(
                id=str(uuid.uuid4()),
                employee_uuid=parsed["employee_uuid"],
                event_uuid=parsed["event_uuid"],
                media_type=parsed["media_type"],
                relative_path=rel_path,
                file_name=parsed["file_name"],
                size_bytes=int(row["SizeBytes"]),
                sha256_hash=sha256,
                exam_date=parsed["exam_date"],
                stored_locally=stored_locally,
                last_write_time=last_write,
                created_at=datetime.now(),          # ← добавить
            )
            session.add(record)

            # Обновляем статистику
            stats["imported"] += 1
            stats["employees"].add(parsed["employee_uuid"])
            if parsed["media_type"] == "photo":
                stats["photos"] += 1
            else:
                stats["videos"] += 1

            # Прогресс каждые 50 записей
            if stats["imported"] % 50 == 0:
                session.commit()
                print(f"  ... импортировано {stats['imported']} записей")

        # Финальный commit
        session.commit()

    # Отчёт
    print()
    print("=" * 60)
    print("  ИТОГ ИМПОРТА")
    print("=" * 60)
    print(f"  Всего строк в CSV:      {stats['total']}")
    print(f"  Импортировано:          {stats['imported']}")
    print(f"  Пропущено (дубли):      {stats['skipped_dup']}")
    print(f"  Пропущено (разбор):     {stats['skipped_parse']}")
    print(f"  ---")
    print(f"  Фото:                   {stats['photos']}")
    print(f"  Видео:                   {stats['videos']}")
    print(f"  Уникальных работников:   {len(stats['employees'])}")
    print(f"  ---")
    print(f"  Хешей вычислено:        {stats['hashes_computed']}")
    print(f"  Файлов не найдено:      {stats['hashes_missing']}")
    print("=" * 60)

    if stats["hashes_missing"] > 0 and media_root:
        print()
        print("  ⚠️ Часть файлов не найдена на диске.")
        print("  Возможные причины:")
        print("    — неверный --media-root")
        print("    — файлы ещё не скачаны из МИС ЕЦОЗ")
        print("    — пути в CSV используют обратные слеши (Windows)")
    elif media_root is None:
        print()
        print("  ℹ️  --media-root не указан, хеши не вычислялись.")
        print("  Запустите с --media-root /path/to/files для расчёта SHA-256.")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Импорт CSV-манифеста медиафайлов ПАК в БД"
    )
    parser.add_argument(
        "--csv",
        required=True,
        help="Путь к CSV-файлу (например pak-media-files-20260909.csv)",
    )
    parser.add_argument(
        "--media-root",
        default=None,
        help="Корневая папка с медиафайлами (для вычисления SHA-256)",
    )
    parser.add_argument(
        "--db-url",
        default="sqlite:///health_id.db",
        help="URL подключения к БД (default: sqlite:///health_id.db)",
    )

    args = parser.parse_args()

    # Проверка существования CSV
    csv_file = Path(args.csv)
    if not csv_file.exists():
        print(f"❌ CSV-файл не найден: {args.csv}")
        sys.exit(1)

    print(f"📄 CSV:       {args.csv}")
    print(f"📁 Media root: {args.media_root or '(не указан)'}")
    print(f"🗄️  БД:        {args.db_url}")
    print()

    import_csv(
        csv_path=args.csv,
        media_root=args.media_root,
        db_url=args.db_url,
    )


if __name__ == "__main__":
    main()
