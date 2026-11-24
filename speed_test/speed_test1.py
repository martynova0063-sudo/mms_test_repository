#!/usr/bin/env python3
"""
speed_test.py — замер скорости скачивания одного URL.

10 последовательных GET-запросов, дожидаемся полного ответа на каждый,
считаем среднее время и суммарный объём, печатаем скорость
и сохраняем отчёт в текстовый файл.
"""

import argparse
import sys
import time
import urllib.request
import urllib.error

CHUNK_SIZE = 64 * 1024  # читаем ответ кусками по 64 КиБ
N_REQUESTS = 10


class Tee:
    """Пишет одновременно в stdout и в файл-отчёт."""
    def __init__(self, file):
        self.file = file

    def write(self, s):
        sys.__stdout__.write(s)
        self.file.write(s)

    def flush(self):
        sys.__stdout__.flush()
        self.file.flush()


def fetch(url: str, timeout: float) -> tuple[int, float]:
    """Один полный GET-запрос. Возвращает (байт скачано, секунд)."""
    start = time.perf_counter()
    downloaded = 0
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        while chunk := resp.read(CHUNK_SIZE):
            downloaded += len(chunk)
    return downloaded, time.perf_counter() - start


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Замер скорости скачивания: 10 последовательных запросов к URL."
    )
    parser.add_argument("url", help="адрес для проверки (например, ссылка на тяжёлый файл)")
    parser.add_argument("--timeout", type=float, default=60.0,
                        help="таймаут одного запроса в секундах (по умолчанию 60)")
    parser.add_argument("--out", default="report.txt",
                        help="файл для отчёта (по умолчанию report.txt)")
    args = parser.parse_args()

    out_file = open(args.out, "w", encoding="utf-8")
    sys.stdout = Tee(out_file)

    print(f"Отчёт о замере скорости: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Цель: {args.url}")
    print(f"Запросов: {N_REQUESTS}\n")

    total_bytes = 0
    total_time = 0.0
    times = []
    failed = False

    for i in range(1, N_REQUESTS + 1):
        try:
            nbytes, elapsed = fetch(args.url, args.timeout)
        except urllib.error.HTTPError as e:
            print(f"[{i:2}/{N_REQUESTS}] HTTP-ошибка {e.code} — прерываю.")
            failed = True
            break
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            print(f"[{i:2}/{N_REQUESTS}] Сбой сети: {e} — прерываю.")
            failed = True
            break

        total_bytes += nbytes
        total_time += elapsed
        times.append(elapsed)
        mib = nbytes / (1024 * 1024)
        speed_mbit = mib / elapsed * 8 if elapsed else 0.0
        print(f"[{i:2}/{N_REQUESTS}] {elapsed:6.2f} с | {mib:8.2f} МиБ | {speed_mbit:7.2f} Мбит/с")

    if times:
        avg_time = total_time / len(times)
        mib_per_s = total_bytes / (1024 * 1024) / total_time if total_time else 0.0

        print("\n--- Итог ---")
        print(f"Скачано всего:   {total_bytes / (1024 * 1024):10.2f} МиБ")
        print(f"Среднее время:   {avg_time:10.2f} с на запрос")
        print(f"Средний размер:  {total_bytes / len(times) / (1024 * 1024):10.2f} МиБ на ответ")
        print(f"Скорость:        {mib_per_s:10.2f} МиБ/с = {mib_per_s * 8:7.2f} Мбит/с")
    else:
        print("Не удалось выполнить ни один запрос.")

    if failed:
        print("\nЗамер прерван ошибкой.")

    out_file.close()
    sys.stdout = sys.__stdout__
    print(f"\nОтчёт сохранён: {args.out}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
