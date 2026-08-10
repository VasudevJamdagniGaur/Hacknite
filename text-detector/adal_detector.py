"""
ADAL AI-generated text detector wrapper.

Model: Shushant/ADAL-detector-large (RoBERTa-large, RADAR-style)
Labels (official model card):
  0 = AI-generated
  1 = Human-written
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any

import torch
from transformers import RobertaForSequenceClassification, RobertaTokenizer

logger = logging.getLogger(__name__)

DEFAULT_MODEL_ID = "Shushant/ADAL-detector-large"
MAX_LENGTH = 512


class AdalNotLoadedError(RuntimeError):
    """Raised when predict() is called before a successful load_model()."""


class AdalDetector:
    """
    Loads ADAL once and runs real model inference (no fabricated scores).

    Methods:
      load_model()
      predict(text) -> dict with probabilities + metadata
    """

    def __init__(
        self,
        model_id: str | None = None,
        models_dir: str | Path | None = None,
        device: str | None = None,
    ) -> None:
        self.model_id = (
            (model_id or os.getenv("ADAL_MODEL_ID", "").strip() or DEFAULT_MODEL_ID)
        )
        self.models_dir = (
            Path(models_dir) if models_dir else Path(__file__).resolve().parent / "models"
        )
        self.models_dir.mkdir(parents=True, exist_ok=True)
        self._device_request = device or os.getenv("ADAL_DEVICE", "auto")

        self.device: torch.device | None = None
        self.model: RobertaForSequenceClassification | None = None
        self.tokenizer: RobertaTokenizer | None = None
        self.model_meta: dict[str, Any] = {}

    def is_ready(self) -> bool:
        return (
            self.model is not None
            and self.tokenizer is not None
            and self.device is not None
        )

    def _resolve_device(self) -> torch.device:
        requested = (self._device_request or "auto").strip().lower()
        cuda_ok = torch.cuda.is_available()

        if requested in {"auto", ""}:
            if cuda_ok:
                device = torch.device("cuda")
                logger.info(
                    "ADAL using CUDA device: %s", torch.cuda.get_device_name(0)
                )
                return device
            logger.warning("CUDA unavailable — ADAL will run on CPU.")
            return torch.device("cpu")

        if requested.startswith("cuda"):
            if not cuda_ok:
                raise RuntimeError(
                    f"ADAL_DEVICE={requested} requested but CUDA is unavailable. "
                    "Install a CUDA-enabled PyTorch build or set ADAL_DEVICE=cpu."
                )
            return torch.device(requested)

        if requested == "cpu":
            logger.info("ADAL using CPU (ADAL_DEVICE=cpu).")
            return torch.device("cpu")

        raise ValueError(f"Unsupported ADAL_DEVICE value: {requested!r}")

    def _resolve_source(self) -> str:
        """Prefer a local snapshot under models/adal if present; else Hub id."""
        local_dir = self.models_dir / "adal"
        if (local_dir / "config.json").is_file():
            return str(local_dir)
        return self.model_id

    def load_model(self) -> "AdalDetector":
        """Download (first run) / load tokenizer + model once at startup."""
        self.device = self._resolve_device()
        source = self._resolve_source()
        logger.info("Loading ADAL from %s onto %s", source, self.device)

        self.tokenizer = RobertaTokenizer.from_pretrained(source)
        self.model = RobertaForSequenceClassification.from_pretrained(source)
        self.model.to(self.device)
        self.model.eval()

        id2label = {
            int(k): str(v) for k, v in (self.model.config.id2label or {}).items()
        }
        # Official mapping: 0=AI, 1=Human. Warn if config disagrees but still use softmax indices.
        if id2label and (0 not in id2label or 1 not in id2label):
            logger.warning("Unexpected ADAL id2label: %s", id2label)

        self.model_meta = {
            "model_id": self.model_id,
            "source": source,
            "device": str(self.device),
            "id2label": id2label,
            "max_length": MAX_LENGTH,
            "cuda_available": torch.cuda.is_available(),
        }
        logger.info(
            "ADAL loaded on %s (cuda_available=%s, id2label=%s)",
            self.device,
            torch.cuda.is_available(),
            id2label or {0: "AI-generated", 1: "Human-written"},
        )
        return self

    @staticmethod
    def _confidence_from_probability(ai_p: float) -> str:
        """Band confidence by distance from an uncertain 0.5 decision."""
        dist = abs(float(ai_p) - 0.5)
        if dist >= 0.35:
            return "high"
        if dist >= 0.20:
            return "medium"
        return "low"

    def predict(self, text: str) -> dict[str, Any]:
        """
        Run ADAL on a single text string.

        Returns real softmax probabilities from the model — never random values.
        """
        if not self.is_ready():
            raise AdalNotLoadedError(
                "ADAL model is not loaded. Call load_model() during application startup."
            )

        assert self.tokenizer is not None
        assert self.model is not None
        assert self.device is not None

        cleaned = " ".join(str(text or "").split()).strip()
        if not cleaned:
            raise ValueError("Text is empty after trimming whitespace.")

        enc = self.tokenizer(
            cleaned,
            return_tensors="pt",
            truncation=True,
            max_length=MAX_LENGTH,
            padding=False,
        )
        enc = {k: v.to(self.device) for k, v in enc.items()}

        t0 = time.perf_counter()
        with torch.no_grad():
            logits = self.model(**enc).logits
            probs = torch.softmax(logits, dim=-1)[0]
        elapsed_ms = (time.perf_counter() - t0) * 1000.0

        if probs.numel() < 2:
            raise RuntimeError(
                f"ADAL expected a 2-class head (AI/human); got {probs.numel()} logit(s)."
            )

        # Official label mapping: 0 = AI-generated, 1 = Human-written
        ai_p = float(probs[0].item())
        human_p = float(probs[1].item())

        if not (0.0 <= ai_p <= 1.0 and 0.0 <= human_p <= 1.0):
            raise RuntimeError(
                f"ADAL returned out-of-range probabilities: ai={ai_p}, human={human_p}"
            )

        ai_likelihood = int(round(ai_p * 100))
        ai_likelihood = max(0, min(100, ai_likelihood))

        return {
            "ai_probability": ai_p,
            "human_probability": human_p,
            "ai_likelihood": ai_likelihood,
            "confidence": self._confidence_from_probability(ai_p),
            "inference_time_ms": round(elapsed_ms, 2),
            "device": str(self.device),
            "model_id": self.model_id,
            "truncated": bool(enc["input_ids"].shape[-1] >= MAX_LENGTH),
            "char_count": len(cleaned),
        }
