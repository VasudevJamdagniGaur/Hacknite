"""
Smoke-test ADAL locally (no FastAPI).

  cd text-detector
  python test_detector.py

First run downloads Shushant/ADAL-detector-large (~1.4GB) into the HF cache.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from adal_detector import AdalDetector

SAMPLES = [
    # Short, casual human-like post
    "just landed in bangalore, traffic is wild today lol",
    # Longer, more formal / possibly AI-like prose
    (
        "In today's rapidly evolving digital landscape, organizations must leverage "
        "synergistic strategies to optimize stakeholder value while fostering "
        "sustainable innovation across multifaceted operational paradigms."
    ),
]


def main() -> int:
    models_dir = Path(__file__).resolve().parent / "models"
    det = AdalDetector(models_dir=models_dir)
    print("Loading ADAL (may download weights on first run)...")
    det.load_model()
    print(json.dumps(det.model_meta, indent=2))
    print("---")

    for i, text in enumerate(SAMPLES, 1):
        print(f"\n[{i}] text={text[:80]}{'…' if len(text) > 80 else ''}")
        try:
            out = det.predict(text)
            print(json.dumps(out, indent=2))
        except Exception as exc:  # noqa: BLE001
            print(f"ERROR: {exc}", file=sys.stderr)
            return 1

    # Empty text must fail safely (no fake score).
    try:
        det.predict("   ")
        print("ERROR: empty text should have raised ValueError", file=sys.stderr)
        return 1
    except ValueError as exc:
        print(f"\nEmpty text correctly rejected: {exc}")

    print("\nOK — ADAL smoke test passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
