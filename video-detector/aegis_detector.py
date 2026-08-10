"""
AEGIS AI-generated video detector wrapper.

Uses the official architecture + inference path from:
  https://github.com/MusapYildiz/ai_video_detection_benchmark
  (src/branches/inference.py → VideoForensicsDetector + video_io.load_video)

Checkpoint:
  MusapYildiz/aegis-video-detector / checkpoint_best.pt
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Any

import torch
from huggingface_hub import hf_hub_download

logger = logging.getLogger(__name__)

HF_REPO_ID = "MusapYildiz/aegis-video-detector"
HF_CHECKPOINT_FILE = "checkpoint_best.pt"

_OFFICIAL_DIR = Path(__file__).resolve().parent / "aegis_official"


class AegisCUDAUnavailableError(RuntimeError):
    """Raised when CUDA is required but not available."""


class AegisNotLoadedError(RuntimeError):
    """Raised when predict() is called before a successful load_model()."""


class AegisDetector:
    """
    Loads the official AEGIS checkpoint once and runs real model inference.

    Methods:
      load_model()
      predict(video_path) -> {ai_generated_probability, real_probability}
    """

    def __init__(
        self,
        checkpoint_path: str | Path | None = None,
        models_dir: str | Path | None = None,
        device: str | None = None,
        require_cuda: bool | None = None,
    ) -> None:
        self.models_dir = Path(models_dir) if models_dir else Path(__file__).resolve().parent / "models"
        self.models_dir.mkdir(parents=True, exist_ok=True)
        self.checkpoint_path = Path(checkpoint_path) if checkpoint_path else None
        self._device_request = device or os.getenv("AEGIS_DEVICE", "auto")
        if require_cuda is None:
            require_cuda = os.getenv("AEGIS_REQUIRE_CUDA", "").lower() in {"1", "true", "yes"}
        self.require_cuda = require_cuda

        self.device: torch.device | None = None
        self.model = None
        self.checkpoint_meta: dict[str, Any] = {}

    def is_ready(self) -> bool:
        return self.model is not None and self.device is not None

    def _resolve_device(self) -> torch.device:
        requested = (self._device_request or "auto").strip().lower()
        cuda_ok = torch.cuda.is_available()

        if requested in {"auto", ""}:
            if cuda_ok:
                device = torch.device("cuda")
                logger.info("AEGIS using CUDA device: %s", torch.cuda.get_device_name(0))
                return device
            if self.require_cuda:
                raise AegisCUDAUnavailableError(
                    "CUDA/GPU is required for AEGIS (AEGIS_REQUIRE_CUDA=1) but "
                    "torch.cuda.is_available() is False. Install a CUDA build of "
                    "PyTorch or unset AEGIS_REQUIRE_CUDA to allow CPU."
                )
            logger.warning(
                "CUDA/GPU unavailable — AEGIS will run on CPU. "
                "Inference will be significantly slower. "
                "Install CUDA-enabled PyTorch for GPU acceleration."
            )
            return torch.device("cpu")

        if requested.startswith("cuda"):
            if not cuda_ok:
                raise AegisCUDAUnavailableError(
                    f"AEGIS_DEVICE={requested} was requested but CUDA is unavailable. "
                    "Install a CUDA-enabled PyTorch build, or set AEGIS_DEVICE=cpu."
                )
            device = torch.device(requested)
            logger.info("AEGIS using requested CUDA device: %s", device)
            return device

        if requested == "cpu":
            if not cuda_ok:
                logger.warning(
                    "CUDA/GPU unavailable — AEGIS running on CPU as requested."
                )
            else:
                logger.info("AEGIS running on CPU (AEGIS_DEVICE=cpu).")
            return torch.device("cpu")

        raise ValueError(f"Unsupported AEGIS_DEVICE value: {requested!r}")

    def _ensure_official_on_path(self) -> None:
        official = str(_OFFICIAL_DIR)
        if official not in sys.path:
            sys.path.insert(0, official)

    def _resolve_checkpoint(self) -> Path:
        if self.checkpoint_path is not None:
            path = Path(self.checkpoint_path)
            if not path.is_file():
                raise FileNotFoundError(f"AEGIS checkpoint not found: {path}")
            return path

        local = self.models_dir / HF_CHECKPOINT_FILE
        if local.is_file():
            return local

        env_path = os.getenv("AEGIS_CHECKPOINT", "").strip()
        if env_path:
            path = Path(env_path)
            if not path.is_file():
                raise FileNotFoundError(f"AEGIS_CHECKPOINT not found: {path}")
            return path

        logger.info(
            "Downloading official AEGIS checkpoint %s/%s ...",
            HF_REPO_ID,
            HF_CHECKPOINT_FILE,
        )
        downloaded = hf_hub_download(
            repo_id=HF_REPO_ID,
            filename=HF_CHECKPOINT_FILE,
            local_dir=str(self.models_dir),
        )
        return Path(downloaded)

    def load_model(self) -> "AegisDetector":
        """
        Download (if needed) and load the official AEGIS checkpoint once.

        Mirrors ``src/branches/inference.py::load_model``.
        """
        self.device = self._resolve_device()
        self._ensure_official_on_path()

        # Official imports (architecture must come from the vendored repo code).
        from detector_model import VideoForensicsDetector  # type: ignore  # noqa: WPS433

        ckpt_path = self._resolve_checkpoint()
        logger.info("Loading AEGIS model from %s onto %s", ckpt_path, self.device)

        try:
            model = VideoForensicsDetector(freeze_dino=True).to(self.device)
        except AegisCUDAUnavailableError:
            raise
        except RuntimeError as exc:
            # Common when a CUDA build is broken / OOM during init.
            msg = str(exc).lower()
            if "cuda" in msg or "cublas" in msg or "cudnn" in msg:
                raise AegisCUDAUnavailableError(
                    f"CUDA error while initializing AEGIS: {exc}. "
                    "Try AEGIS_DEVICE=cpu or fix your GPU/PyTorch CUDA install."
                ) from exc
            raise

        state = torch.load(ckpt_path, map_location=self.device, weights_only=False)
        if not isinstance(state, dict) or "model_state" not in state:
            raise RuntimeError(
                f"Invalid AEGIS checkpoint format at {ckpt_path}: "
                "expected a dict with key 'model_state' (official format)."
            )

        missing, unexpected = model.load_state_dict(state["model_state"], strict=True)
        if missing or unexpected:
            raise RuntimeError(
                f"AEGIS state_dict mismatch. missing={missing} unexpected={unexpected}"
            )

        model.eval()
        self.model = model
        self.checkpoint_meta = {
            "checkpoint_path": str(ckpt_path),
            "epoch": state.get("epoch"),
            "metrics": state.get("metrics", {}),
            "device": str(self.device),
            "cuda_available": torch.cuda.is_available(),
        }
        metrics = self.checkpoint_meta.get("metrics") or {}
        logger.info(
            "AEGIS loaded (epoch=%s, val_auc=%s) on %s",
            self.checkpoint_meta.get("epoch"),
            metrics.get("auc"),
            self.device,
        )
        return self

    @torch.inference_mode()
    def predict(self, video_path: str | Path) -> dict[str, float]:
        """
        Run official AEGIS inference on one video.

        Returns:
            {
              "ai_generated_probability": float,
              "real_probability": float,
            }
        """
        if not self.is_ready():
            raise AegisNotLoadedError(
                "AEGIS model is not loaded. Call load_model() during application startup."
            )

        assert self.model is not None and self.device is not None
        self._ensure_official_on_path()
        from video_io import VideoQualityError, load_video  # type: ignore  # noqa: WPS433

        path = str(video_path)
        if not Path(path).is_file():
            raise FileNotFoundError(f"Video not found: {path}")

        try:
            # Match official inference.py::analyze_video preprocessing.
            bundle = load_video(path, n_frames=16, n_semantic=8)
            frames = bundle.frames_all.unsqueeze(0).to(self.device)  # (1, 16, 3, 224, 224)
            outputs = self.model(frames)
            ai_prob = float(outputs["ai_probability"].item())
        except VideoQualityError as exc:
            raise ValueError(f"AEGIS rejected video quality: {exc}") from exc
        except RuntimeError as exc:
            msg = str(exc).lower()
            if "cuda" in msg or "cublas" in msg or "cudnn" in msg:
                raise AegisCUDAUnavailableError(
                    f"CUDA error during AEGIS inference: {exc}. "
                    "Retry with AEGIS_DEVICE=cpu or fix GPU drivers/PyTorch CUDA."
                ) from exc
            raise

        if not (0.0 <= ai_prob <= 1.0):
            raise RuntimeError(f"AEGIS returned out-of-range probability: {ai_prob}")

        return {
            "ai_generated_probability": ai_prob,
            "real_probability": float(1.0 - ai_prob),
        }
