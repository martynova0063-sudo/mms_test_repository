"""
Сиамская сеть для anti-spoofing (liveness detection).
Сравнивает кадр из видео с эталонными прототипами живого лица.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
import numpy as np
from pathlib import Path
import cv2
from typing import Optional
from dataclasses import dataclass


# ──────────────────────────────────────────────
# 1. Архитектура сети
# ──────────────────────────────────────────────

class FaceEncoder(nn.Module):
    """Свёрточный энкодер: изображение → вектор признаков (128-мерный)."""

    def __init__(self, input_channels: int = 3, embedding_dim: int = 128):
        super().__init__()

        self.features = nn.Sequential(
            # Block 1
            nn.Conv2d(input_channels, 32, kernel_size=3, padding=1),
            nn.BatchNorm2d(32),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),  # 128x128 → 64x64

            # Block 2
            nn.Conv2d(32, 64, kernel_size=3, padding=1),
            nn.BatchNorm2d(64),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),  # → 32x32

            # Block 3
            nn.Conv2d(64, 128, kernel_size=3, padding=1),
            nn.BatchNorm2d(128),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),  # → 16x16

            # Block 4
            nn.Conv2d(128, 256, kernel_size=3, padding=1),
            nn.BatchNorm2d(256),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),  # → 8x8

            # Global Average Pooling
            nn.AdaptiveAvgPool2d(1),  # → 1x1
        )

        self.embedding = nn.Sequential(
            nn.Flatten(),
            nn.Linear(256, 256),
            nn.ReLU(inplace=True),
            nn.Dropout(0.3),
            nn.Linear(256, embedding_dim),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """
        Args:
            x: (B, C, H, W) — нормализованные изображения лиц
        Returns:
            (B, embedding_dim) — L2-нормализованные векторы признаков
        """
        features = self.features(x)
        embedding = self.embedding(features)
        # L2-нормализация: векторы лежат на единичной сфере
        embedding = F.normalize(embedding, p=2, dim=1)
        return embedding


class SiameseAntiSpoofing(nn.Module):
    """
    Сиамская сеть: два изображения → расстояние → вероятность live/spoof.

    Принимает пару (probe, reference), пропускает оба через общий энкодер,
    считает расстояние и выдаёт вероятность, что probe — живое лицо.
    """

    def __init__(self, embedding_dim: int = 128):
        super().__init__()
        self.encoder = FaceEncoder(input_channels=3, embedding_dim=embedding_dim)

    def forward(
        self,
        probe: torch.Tensor,
        reference: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """
        Args:
            probe:     (B, C, H, W) — проверяемый кадр
            reference: (B, C, H, W) — эталон (прототип живого лица)
        Returns:
            distance:  (B,) — L2-расстояние между эмбеддингами
            prob_live: (B,) — вероятность, что probe живое (0..1)
        """
        emb_probe = self.encoder(probe)
        emb_ref = self.encoder(reference)

        # Евклидово расстояние на единичной сфере
        distance = F.pairwise_distance(emb_probe, emb_ref)

        # Чем меньше расстояние → тем больше вероятность live
        # Сигмоид от отрицательного расстояния: dist≈0 → prob≈0.5
        # Обучаемое смещение и масштаб
        prob_live = torch.sigmoid(-distance)

        return distance, prob_live


# ──────────────────────────────────────────────
# 2. Contrastive Loss
# ──────────────────────────────────────────────

class ContrastiveLoss(nn.Module):
    """
    Contrastive Loss для обучения сиамской сети.

    L = Y * D² + (1 - Y) * max(margin - D, 0)²

    где Y=1 — одинаковые (оба живые или оба spoof),
       Y=0 — разные (live vs spoof),
       D — расстояние между эмбеддингами,
       margin — отступ.
    """

    def __init__(self, margin: float = 2.0):
        super().__init__()
        self.margin = margin

    def forward(
        self,
        distance: torch.Tensor,
        label: torch.Tensor,
    ) -> torch.Tensor:
        """
        Args:
            distance: (B,) — расстояния между парами
            label:    (B,) — 1 = одинаковый класс, 0 = разные классы
        Returns:
            scalar loss
        """
        # Для live-live пар: минимизируем расстояние
        positive_loss = label * torch.pow(distance, 2)

        # Для live-spoof пар: раздвигаем на margin
        negative_loss = (1 - label) * torch.pow(
            torch.clamp(self.margin - distance, min=0.0), 2
        )

        return torch.mean(positive_loss + negative_loss)


# ──────────────────────────────────────────────
# 3. Датасет
# ──────────────────────────────────────────────

@dataclass
class SpoofSample:
    image_path: str
    is_live: bool  # True — живое, False — подмена


class SiameseLivenessDataset(Dataset):
    """
    Датасет для сиамской сети: формирует пары (probe, reference).

    Стратегия:
    - Если probe live → reference = другой live кадр (positive pair, label=1)
    - Если probe spoof → reference = случайный live кадр (negative pair, label=0)
    """

    def __init__(
        self,
        samples: list[SpoofSample],
        live_prototypes: list[np.ndarray],
        image_size: tuple[int, int] = (128, 128),
        augment: bool = True,
    ):
        self.samples = samples
        self.live_prototypes = live_prototypes  # заранее подготовленные живые эталоны
        self.image_size = image_size
        self.augment = augment

    def __len__(self) -> int:
        return len(self.samples)

    def _load_image(self, path: str) -> torch.Tensor:
        """Загрузка и препроцессинг изображения лица."""
        img = cv2.imread(path)
        if img is None:
            raise FileNotFoundError(f"Cannot read: {path}")

        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        img = cv2.resize(img, self.image_size)

        # Аугментация
        if self.augment and np.random.random() > 0.5:
            # Лёгкий random brightness
            brightness = np.random.uniform(0.8, 1.2)
            img = np.clip(img * brightness, 0, 255).astype(np.uint8)

        # Нормализация: (H, W, C) → (C, H, W), /255, ImageNet stats
        img = img.astype(np.float32) / 255.0
        img = (img - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]
        img = torch.from_numpy(img).permute(2, 0, 1).float()

        return img

    def __getitem__(self, idx: int) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        sample = self.samples[idx]

        probe = self._load_image(sample.image_path)

        if sample.is_live:
            # Пара live-live: выбираем другой live кадр
            other_live = np.random.choice(self.live_prototypes)
            reference = torch.from_numpy(other_live).permute(2, 0, 1).float()
            label = torch.tensor(1.0)  # одинаковые
        else:
            # Пара spoof-live: выбираем случайный live прототип
            ref_idx = np.random.randint(len(self.live_prototypes))
            reference = torch.from_numpy(self.live_prototypes[ref_idx]).permute(2, 0, 1).float()
            label = torch.tensor(0.0)  # разные

        return probe, reference, label


# ──────────────────────────────────────────────
# 4. Обучение
# ──────────────────────────────────────────────

def train_siamese(
    train_dataset: SiameseLivenessDataset,
    val_dataset: Optional[SiameseLivenessDataset] = None,
    epochs: int = 50,
    batch_size: int = 32,
    lr: float = 1e-4,
    margin: float = 2.0,
    device: str = "cuda" if torch.cuda.is_available() else "cpu",
    save_path: str = "siamese_liveness.pt",
):
    """Обучение сиамской сети для anti-spoofing."""

    model = SiameseAntiSpoofing(embedding_dim=128).to(device)
    criterion = ContrastiveLoss(margin=margin)
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs)

    train_loader = DataLoader(
        train_dataset, batch_size=batch_size, shuffle=True, num_workers=4, drop_last=True
    )

    val_loader = None
    if val_dataset:
        val_loader = DataLoader(val_dataset, batch_size=batch_size, shuffle=False)

    best_val_acc = 0.0

    for epoch in range(epochs):
        # --- Train ---
        model.train()
        total_loss = 0.0
        correct = 0
        total = 0

        for probe, reference, labels in train_loader:
            probe = probe.to(device)
            reference = reference.to(device)
            labels = labels.to(device)

            distance, prob_live = model(probe, reference)
            loss = criterion(distance, labels)

            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()

            total_loss += loss.item() * probe.size(0)
            # prob_live > 0.5 → предсказание "live"
            preds = (prob_live > 0.5).float()
            correct += (preds == labels).sum().item()
            total += labels.size(0)

        train_loss = total_loss / total
        train_acc = correct / total

        # --- Validation ---
        val_acc = 0.0
        if val_loader:
            model.eval()
            correct = 0
            total = 0
            with torch.no_grad():
                for probe, reference, labels in val_loader:
                    probe = probe.to(device)
                    reference = reference.to(device)
                    labels = labels.to(device)

                    _, prob_live = model(probe, reference)
                    preds = (prob_live > 0.5).float()
                    correct += (preds == labels).sum().item()
                    total += labels.size(0)
            val_acc = correct / total

        scheduler.step()

        msg = f"Epoch {epoch+1}/{epochs} | Loss: {train_loss:.4f} | Train Acc: {train_acc:.3f}"
        if val_loader:
            msg += f" | Val Acc: {val_acc:.3f}"
            if val_acc > best_val_acc:
                best_val_acc = val_acc
                torch.save(model.state_dict(), save_path)
                msg += " | ✅ Saved"
        else:
            torch.save(model.state_dict(), save_path)

        print(msg)

    print(f"\n✅ Training complete. Best val acc: {best_val_acc:.3f}")
    return model


# ──────────────────────────────────────────────
# 5. Инференс — интеграция в пайплайн
# ──────────────────────────────────────────────

class SiameseLivenessChecker:
    """
    Инференс сиамской сети для проверки liveness.

    Интегрируется в существующий пайплайн BiometricVerifier
    как альтернативный или дополнительный liveness-модуль.
    """

    def __init__(
        self,
        model_path: str,
        device: str = "cuda" if torch.cuda.is_available() else "cpu",
        threshold: float = 0.5,
        image_size: tuple[int, int] = (128, 128),
    ):
        self.device = device
        self.threshold = threshold
        self.image_size = image_size

        self.model = SiameseAntiSpoofing(embedding_dim=128)
        self.model.load_state_dict(torch.load(model_path, map_location=device))
        self.model.to(device)
        self.model.eval()

    def _preprocess(self, frame: np.ndarray) -> torch.Tensor:
        """Препроцессинг кадра OpenCV → tensor."""
        if frame.shape[2] == 4:
            frame = cv2.cvtColor(frame, cv2.COLOR_BGRA2BGR)
        if frame.shape[2] == 3:
            frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

        frame = cv2.resize(frame, self.image_size)
        frame = frame.astype(np.float32) / 255.0
        frame = (frame - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]
        tensor = torch.from_numpy(frame).permute(2, 0, 1).float()
        return tensor.unsqueeze(0)  # (1, C, H, W)

    def check(
        self,
        probe_frame: np.ndarray,
        reference_frame: np.ndarray,
    ) -> dict:
        """
        Проверка liveness: сравнение кадра из видео с эталоном.

        Args:
            probe_frame:     кадр из видео (H, W, 3) — проверяемое лицо
            reference_frame: эталонный кадр живого лица (H, W, 3)

        Returns:
            {
                "is_live": bool,
                "liveness_score": float,  # вероятность live (0..1)
                "distance": float,         # расстояние в пространстве эмбеддингов
                "threshold": float,
            }
        """
        probe = self._preprocess(probe_frame).to(self.device)
        reference = self._preprocess(reference_frame).to(self.device)

        with torch.no_grad():
            distance, prob_live = self.model(probe, reference)

        distance_val = float(distance.item())
        score = float(prob_live.item())

        return {
            "is_live": score >= self.threshold,
            "liveness_score": score,
            "distance": distance_val,
            "threshold": self.threshold,
        }

    def check_video(
        self,
        video_path: str,
        reference_frame: np.ndarray,
        sample_every_n_frames: int = 10,
    ) -> dict:
        """
        Проверка liveness по видео: берёт несколько кадров,
        усредняет score.

        Args:
            video_path: путь к видео файлу
            reference_frame: эталон живого лица
            sample_every_n_frames: каждые N кадров брать один

        Returns:
            {
                "is_live": bool,
                "liveness_score": float,  # усреднённый
                "scores_per_frame": list[float],
                "num_frames_checked": int,
            }
        """
        cap = cv2.VideoCapture(video_path)
        scores = []

        frame_idx = 0
        while True:
            ret, frame = cap.read()
            if not ret:
                break

            if frame_idx % sample_every_n_frames == 0:
                result = self.check(frame, reference_frame)
                scores.append(result["liveness_score"])

            frame_idx += 1

        cap.release()

        if not scores:
            return {
                "is_live": False,
                "liveness_score": 0.0,
                "scores_per_frame": [],
                "num_frames_checked": 0,
                "error": "no_frames_extracted",
            }

        avg_score = float(np.mean(scores))
        min_score = float(np.min(scores))  # worst case
        # Финальное решение: среднее, но учитываем и минимум
        final_score = (avg_score + min_score) / 2

        return {
            "is_live": final_score >= self.threshold,
            "liveness_score": final_score,
            "scores_per_frame": scores,
            "num_frames_checked": len(scores),
        }
