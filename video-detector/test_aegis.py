"""
Smoke-test official AEGIS on video-detector/test_video.mp4.

Usage (from video-detector/):
  python test_aegis.py
"""

from __future__ import annotations

import time
from pathlib import Path

from aegis_detector import AegisDetector

ROOT = Path(__file__).resolve().parent
VIDEO_PATH = ROOT / "test_video.mp4"


def main() -> None:
    if not VIDEO_PATH.is_file():
        raise FileNotFoundError(f"Missing test video: {VIDEO_PATH}")

    print(f"Video: {VIDEO_PATH}")
    print("Loading AEGIS (checkpoint + DINOv2)...")
    detector = AegisDetector(models_dir=ROOT / "models")
    detector.load_model()
    print(f"Device: {detector.checkpoint_meta.get('device')}")
    print(f"Checkpoint: {detector.checkpoint_meta.get('checkpoint_path')}")

    print("\nRunning inference...")
    t0 = time.perf_counter()
    result = detector.predict(VIDEO_PATH)
    elapsed = time.perf_counter() - t0

    ai_prob = result["ai_generated_probability"]
    real_prob = result["real_probability"]

    print("\n=== AEGIS Result ===")
    print(f"AI-generated probability: {ai_prob:.6f} ({ai_prob * 100:.2f}%)")
    print(f"Real probability:         {real_prob:.6f} ({real_prob * 100:.2f}%)")
    print(f"Inference time:           {elapsed:.3f}s")


if __name__ == "__main__":
    main()
