#!/usr/bin/env python3
"""
speed_test.py — замер скорости скачивания одного URL.

10 последовательных GET-запросов, дожидаемся полного ответа на каждый,
считаем среднее время и суммарный объём, печатаем скорость.
"""

import argparse
import sys
import time
import urllib.request
import urllib.error

CHUNK_SIZE = 64 * 1024  # читаем ответ кусками по 64 КБ
N_REQUESTS = 10


def fetch(url: str, timeout: float) -> tuple[int, float]:
    """Один полный GET-запрос. Возвращает (байт скачано, секунд)."""
    start = time.perf_counter()
    downloaded = 0
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        # принудительно читаем всё тело ответа
        while chunk := resp.read(CHUNK_SIZE):
            downloaded += len(chunk)
    return downloaded, time.perf_counter() - start


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Замер скорости скачивания: 10 последовательных запросов к URL."
    )
    parser.add_argument("url", help="адрес для проверки (например, ссылка на тяжёлый файл)")
    parser.add_argument(
        "--timeout", type=float, default=60.0,
        help="таймаут одного запроса в секундах (по умолчанию 60)",
    )
    args = parser.parse_args()

    print(f"Цель: {args.url}")
    print(f"Запросов: {N_REQUESTS}\n")

    total_bytes = 0
    total_time = 0.0
    times = []

    for i in range(1, N_REQUESTS + 1):
        try:
            nbytes, elapsed = fetch(args.url, args.timeout)
        except urllib.error.HTTPError as e:
            print(f"[{i:2}/{N_REQUESTS}] HTTP-ошибка {e.code} — прерываю.")
            return 1
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            print(f"[{i:2}/{N_REQUESTS}] Сбой сети: {e} — прерываю.")
            return 1

        total_bytes += nbytes
        total_time += elapsed
        times.append(elapsed)
        mib = nbytes / (1024 * 1024)
        print(f"[{i:2}/{N_REQUESTS}] {elapsed:6.2f} с | {mib:8.2f} МиБ | "
              f"{mib / elapsed * 8:7.2f} Мбит/с" if elapsed else f"[{i:2}/{N_REQUESTS}] 0.00 с")

    if not times:
        print("Не удалось выполнить ни один запрос.")
        return 1

    avg_time = total_time / len(times)
    avg_bytes = total_bytes / len(times)
    # скорость считаем как суммарные байты / суммарное время всех запросов
    mib_per_s = total_bytes / (1024 * 1024) / total_time if total_time else 0.0

    print("\n--- Итог ---")
    print(f"Скачано всего:   {total_bytes / (1024 * 1024):10.2f} МиБ")
    print(f"Среднее время:   {avg_time:10.2f} с на запрос")
    print(f"Средний размер:  {avg_bytes / (1024 * 1024):10.2f} МиБ на ответ")
    print(f"Скорость:        {mib_per_s:10.2f} МиБ/с = {mib_per_s * 8:7.2f} Мбит/с")
    return 0


if __name__ == "__main__":
    sys.exit(main())
