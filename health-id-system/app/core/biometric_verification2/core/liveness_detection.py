"""
Модуль 4.1.2 - Liveness Detection.
1. Eye blink (Sobel gradient proxy)
2. Head movement (optical flow + bbox shift)
3. Texture (LBP entropy + FFT)
4. Depth (monocular proxy)
"""
from __future__ import annotations
import cv2, numpy as np
from dataclasses import dataclass, field
from enum import Enum
from .face_detector import get_face_detector
from ..config.settings import ModelConfig

class LivenessDecision(str, Enum):
    LIVE = "live"; SPOOF_DETECTED = "spoof_detected"; INCONCLUSIVE = "inconclusive"

class AttackType(str, Enum):
    NONE = "none"; PHOTO_PRINT = "photo_print"; SCREEN_REPLAY = "screen_replay"
    VIDEO_REPLAY = "video_replay"; MASK_3D = "mask_3d"

@dataclass
class LivenessSignal:
    score: float; passed: bool; weight: float
    details: dict = field(default_factory=dict)

@dataclass
class LivenessOutput:
    liveness_score: float; liveness_signals: dict; decision: str
    evidence_frames: list = field(default_factory=list)
    attack_type: str = AttackType.NONE.value
    n_frames_processed: int = 0

class LivenessDetector:
    def __init__(self, config=None):
        self.config = config or ModelConfig()
        self.detector = get_face_detector()
        self.thr = self.config.liveness

    def detect(self, video_path):
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return LivenessOutput(0.0, {}, LivenessDecision.INCONCLUSIVE.value, [])
        frames = []; idx = 0
        mx = self.config.max_frames_to_process
        prev_g = None; prev_b = None
        while idx < mx:
            ret, frame = cap.read()
            if not ret: break
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = self.detector.detect(frame)
            fi = {"idx": idx, "has_face": False, "eye": 0.0,
                  "motion": 0.0, "lbp": 0.0, "fft": 0.0, "depth": 0.5}
            if faces:
                f = faces[0]; crop = frame[f.y:f.y+f.h, f.x:f.x+f.w]
                if crop.size > 0:
                    fi["has_face"] = True
                    eh = max(10, int(f.h*0.15)); ew = max(20, int(f.w*0.3))
                    ey = f.y + int(f.h*0.2); ex = f.x + int(f.w*0.1)
                    er = gray[max(0,ey):ey+eh, max(0,ex):ex+ew]
                    if er.size > 0:
                        gx = cv2.Sobel(er, cv2.CV_32F, 1, 0, ksize=3)
                        gy = cv2.Sobel(er, cv2.CV_32F, 0, 1, ksize=3)
                        fi["eye"] = float(np.var(np.arctan2(gy, gx)))
                    if prev_g is not None and prev_b is not None:
                        flow = cv2.calcOpticalFlowFarneback(
                            prev_g, gray, None, 0.5, 3, 15, 3, 5, 1.2, 0)
                        dx = abs((f.x+f.w/2) - (prev_b[0]+prev_b[2]/2))
                        dy = abs((f.y+f.h/2) - (prev_b[1]+prev_b[3]/2))
                        fm = float(np.mean(np.sqrt(
                            flow[...,0]**2 + flow[...,1]**2)))
                        fi["motion"] = min(1.0, (dx+dy)/50.0 + fm/5.0)
                    prev_g = gray.copy(); prev_b = (f.x, f.y, f.w, f.h)
                    fg = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if len(crop.shape) == 3 else crop
                    fi["lbp"] = self._lbp_e(fg); fi["fft"] = self._fft_r(fg)
                    if self.thr.depth_enabled and prev_g is not None:
                        bf2 = cv2.calcOpticalFlowFarneback(
                            prev_g, gray, None, 0.5, 2, 10, 2, 5, 1.2, 0)
                        bgm = float(np.mean(np.sqrt(
                            bf2[...,0]**2 + bf2[...,1]**2)))
                        fi["depth"] = min(1.0, abs(fi["motion"]-bgm)/3.0 + 0.3)
            frames.append(fi); idx += 1
        cap.release()
        return self._agg(frames)

    def _lbp_e(self, g, bins=64):
        h, w = g.shape
        if h < 3 or w < 3: return 0.0
        lbp = np.zeros((h-2, w-2), dtype=np.uint8)
        for i in range(1, h-1):
            for j in range(1, w-1):
                c = g[i,j]; code = 0
                code |= (g[i-1,j-1] >= c) << 7; code |= (g[i-1,j] >= c) << 6
                code |= (g[i-1,j+1] >= c) << 5; code |= (g[i,j+1] >= c) << 4
                code |= (g[i+1,j+1] >= c) << 3; code |= (g[i+1,j] >= c) << 2
                code |= (g[i+1,j-1] >= c) << 1; code |= (g[i,j-1] >= c) << 0
                lbp[i-1, j-1] = code
        hist, _ = np.histogram(lbp, bins=bins, range=(0, 256))
        hist = hist.astype(np.float32); s = hist.sum()
        if s > 0: hist /= s
        e = -np.sum(hist[hist > 0] * np.log2(hist[hist > 0]))
        me = np.log2(bins)
        return float(e / me) if me > 0 else 0.0

    def _fft_r(self, g):
        f = np.fft.fft2(g.astype(np.float32)); f = np.fft.fftshift(f)
        m = np.abs(f); h, w = m.shape; cy, cx = h//2, w//2
        mr = min(cy, cx)
        if mr < 2: return 0.5
        lr = int(mr * 0.1)
        le = float(m[cy-lr:cy+lr, cx-lr:cx+lr].sum())
        t = float(m.sum())
        return float(le / t) if t > 1e-8 else 0.5

    def _agg(self, frames):
        ff = [f for f in frames if f["has_face"]]
        if not ff:
            return LivenessOutput(0.0, {}, LivenessDecision.INCONCLUSIVE.value,
                [], n_frames_processed=len(frames))
        ev = [f["eye"] for f in ff]
        if len(ev) >= 3:
            mv = float(np.mean(ev)); sv = float(np.std(ev)); dips = 0
            th = mv - 0.5*sv if sv > 0 else mv*0.7
            for v in ev:
                if v < th: dips += 1
            bs = min(1.0, dips / max(self.thr.blink_min_count, 1))
        else:
            dips = 0; bs = 0.0
        bp = bs >= self.thr.blink_min_ratio
        mo = [f["motion"] for f in ff]
        mf = sum(1 for m in mo if m > 0.1)
        ms = min(1.0, mf / max(self.thr.head_motion_min_frames, 1))
        mp = mf >= self.thr.head_motion_min_frames
        lv = [f["lbp"] for f in ff]; fv = [f["fft"] for f in ff]
        al = float(np.mean(lv)) if lv else 0.0
        af = float(np.mean(fv)) if fv else 0.5
        tl = min(1.0, al / max(self.thr.texture_lbp_threshold, 0.01))
        tf = 1.0 - min(1.0, abs(af - 0.5) / 0.3)
        ts = tl*0.5 + tf*0.5; tp = ts >= 0.5
        dv = [f["depth"] for f in ff]
        ds = float(np.mean(dv)) if dv else 0.5
        if not self.thr.depth_enabled: ds = 0.5
        dp = ds >= 0.4 if self.thr.depth_enabled else True
        tw = (self.thr.blink_weight + self.thr.head_motion_weight +
              self.thr.texture_weight + self.thr.depth_weight)
        ls = (bs*self.thr.blink_weight + ms*self.thr.head_motion_weight +
              ts*self.thr.texture_weight + ds*self.thr.depth_weight) / tw
        ef = []; me = float(np.mean(ev)) if ev else 0.0
        se = float(np.std(ev)) if ev else 0.0
        for f in ff:
            if bp and f["eye"] < me - se: ef.append(f["idx"])
            if not tp and f["lbp"] < self.thr.texture_lbp_threshold:
                if f["idx"] not in ef: ef.append(f["idx"])
        at = self._attack(bp, mp, tp, dp)
        if ls >= self.thr.liveness_pass: d = LivenessDecision.LIVE.value
        elif ls < self.thr.liveness_fail: d = LivenessDecision.SPOOF_DETECTED.value
        else: d = (LivenessDecision.SPOOF_DETECTED.value
                   if (ts < 0.3 or bs < 0.15)
                   else LivenessDecision.INCONCLUSIVE.value)
        sig = {
            "blink": LivenessSignal(round(bs,4), bp, self.thr.blink_weight, {"dips": dips}),
            "head_motion": LivenessSignal(round(ms,4), mp, self.thr.head_motion_weight, {"frames": mf}),
            "texture": LivenessSignal(round(ts,4), tp, self.thr.texture_weight, {"lbp": round(al,4), "fft": round(af,4)}),
            "depth": LivenessSignal(round(ds,4), dp, self.thr.depth_weight, {"enabled": self.thr.depth_enabled}),
        }
        return LivenessOutput(round(ls,4), sig, d, ef, at, len(frames))

    def _attack(self, b, m, t, d):
        if b and m and t and d: return AttackType.NONE.value
        if not b and not m and t: return AttackType.PHOTO_PRINT.value
        if not b and m and not t: return AttackType.SCREEN_REPLAY.value
        if b and m and not t: return AttackType.VIDEO_REPLAY.value
        if b and m and t and not d: return AttackType.MASK_3D.value
        return AttackType.NONE.value
