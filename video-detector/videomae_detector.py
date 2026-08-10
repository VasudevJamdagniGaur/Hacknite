"""
VideoMAE deepfake detector.

Uses the pretrained Hugging Face checkpoint:
  Vansh180/VideoMae-ffc23-deepfake-detector

Labels (from model config):
  0 = real
  1 = fake
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

import numpy as np
import torch
from PIL import Image
from transformers import VideoMAEForVideoClassification, VideoMAEImageProcessor

logger = logging.getLogger(__name__)

DEFAULT_MODEL_ID = "Vansh180/VideoMae-ffc23-deepfake-detector"
NUM_FRAMES = 16


class VideoMAENotLoadedError(RuntimeError):
    """Raised when predict() is called before a successful load_model()."""


class VideoMAEDetector:
    """
    Pretrained VideoMAE deepfake classifier.

    Methods:
      load_model()
      predict(video_path) -> {deepfake_probability, real_probability}
    """

    def __init__(
        self,
        model_id: str | None = None,
        models_dir: str | Path | None = None,
        device: str | None = None,
    ) -> None:
        self.model_id = (
            model_id
            or os.getenv("VIDEOMAE_MODEL_ID", "").strip()
            or DEFAULT_MODEL_ID
        )
        self.models_dir = (
            Path(models_dir) if models_dir else Path(__file__).resolve().parent / "models"
        )
        self.models_dir.mkdir(parents=True, exist_ok=True)
        self._device_request = device or os.getenv("VIDEOMAE_DEVICE", "auto")

        self.device: torch.device | None = None
        self.model: VideoMAEForVideoClassification | None = None
        self.processor: VideoMAEImageProcessor | None = None
        self.model_meta: dict[str, Any] = {}

    def is_ready(self) -> bool:
        return self.model is not None and self.processor is not None and self.device is not None

    def _resolve_device(self) -> torch.device:
        requested = (self._device_request or "auto").strip().lower()
        cuda_ok = torch.cuda.is_available()

        if requested in {"auto", ""}:
            if cuda_ok:
                device = torch.device("cuda")
                logger.info("VideoMAE using CUDA: %s", torch.cuda.get_device_name(0))
                return device
            logger.warning("CUDA unavailable — VideoMAE will run on CPU.")
            return torch.device("cpu")

        if requested.startswith("cuda"):
            if not cuda_ok:
                raise RuntimeError(
                    f"VIDEOMAE_DEVICE={requested} requested but CUDA is unavailable. "
                    "Install a CUDA-enabled PyTorch build or set VIDEOMAE_DEVICE=cpu."
                )
            return torch.device(requested)

        if requested == "cpu":
            return torch.device("cpu")

        raise ValueError(f"Unsupported VIDEOMAE_DEVICE value: {requested!r}")

    def _resolve_source(self) -> str:
        local_dir = self.models_dir / "videomae"
        if (local_dir / "config.json").is_file():
            return str(local_dir)
        return self.model_id

    def load_model(self) -> "VideoMAEDetector":
        """Load processor + model once (call at FastAPI startup)."""
        self.device = self._resolve_device()
        source = self._resolve_source()
        logger.info("Loading VideoMAE from %s onto %s", source, self.device)

        self.processor = VideoMAEImageProcessor.from_pretrained(source)

        # Newer transformers renamed attention biases (q_bias/v_bias → query/value.bias).
        # Remap checkpoint keys so we do not leave randomly initialized biases.
        self.model = self._load_model_with_bias_remap(source)
        self.model.to(self.device)
        self.model.eval()

        id2label = {int(k): str(v) for k, v in (self.model.config.id2label or {}).items()}
        if id2label.get(0, "").lower() != "real" or id2label.get(1, "").lower() != "fake":
            # Still accept if indices exist; warn on unexpected names.
            if 0 not in id2label or 1 not in id2label:
                raise RuntimeError(
                    f"Unexpected VideoMAE id2label (need 0/1 real/fake): {id2label}"
                )
            logger.warning("VideoMAE id2label differs from expected real/fake: %s", id2label)

        self.model_meta = {
            "model_id": self.model_id,
            "source": source,
            "device": str(self.device),
            "id2label": id2label,
            "num_frames": int(getattr(self.model.config, "num_frames", NUM_FRAMES) or NUM_FRAMES),
            "cuda_available": torch.cuda.is_available(),
        }
        logger.info(
            "VideoMAE loaded (id2label=%s) on %s",
            id2label,
            self.device,
        )
        return self

    @staticmethod
    def _load_model_with_bias_remap(source: str) -> VideoMAEForVideoClassification:
        from transformers import AutoConfig

        config = AutoConfig.from_pretrained(source)
        model = VideoMAEForVideoClassification(config)

        # Prefer local / hub weights via from_pretrained internals.
        try:
            from huggingface_hub import hf_hub_download
            from safetensors.torch import load_file

            if Path(source).is_dir() and (Path(source) / "model.safetensors").is_file():
                weights_path = str(Path(source) / "model.safetensors")
            else:
                weights_path = hf_hub_download(repo_id=source, filename="model.safetensors")
            raw_state = load_file(weights_path)
        except Exception:
            # Fallback path for pytorch_model.bin style checkpoints.
            probe = VideoMAEForVideoClassification.from_pretrained(source)
            raw_state = probe.state_dict()
            del probe

        remapped: dict[str, torch.Tensor] = {}
        for key, value in raw_state.items():
            if key.endswith("attention.attention.q_bias"):
                remapped[key.replace("q_bias", "query.bias")] = value
            elif key.endswith("attention.attention.v_bias"):
                remapped[key.replace("v_bias", "value.bias")] = value
            else:
                remapped[key] = value

        # Original VideoMAE used no key bias; keep zeros already in the module.
        missing, unexpected = model.load_state_dict(remapped, strict=False)
        missing_critical = [
            k
            for k in missing
            if not k.endswith("key.bias")
            and "position_ids" not in k
        ]
        if missing_critical:
            raise RuntimeError(f"VideoMAE missing critical weights after remap: {missing_critical}")
        if unexpected:
            logger.warning("VideoMAE unexpected keys after remap: %s", unexpected)

        return model

    def _load_video_frames(self, video_path: str | Path, num_frames: int = NUM_FRAMES) -> list[Image.Image]:
        """
        Uniformly sample ``num_frames`` RGB frames.

        Videos shorter than ``num_frames`` are padded by repeating the last frame
        (never invents pixel content beyond repeating observed frames).
        """
        path = str(video_path)
        if not Path(path).is_file():
            raise FileNotFoundError(f"Video not found: {path}")

        try:
            from decord import VideoReader, cpu

            vr = VideoReader(path, ctx=cpu(0))
            total_frames = len(vr)
            if total_frames <= 0:
                raise ValueError(f"Video has no frames: {path}")

            if total_frames == 1:
                indices = np.array([0], dtype=int)
            elif total_frames < num_frames:
                # Take every available frame, then pad after decode.
                indices = np.arange(total_frames, dtype=int)
            else:
                indices = np.linspace(0, total_frames - 1, num_frames).astype(int)

            batch = vr.get_batch(indices.tolist()).asnumpy()
            frames = [Image.fromarray(frame).convert("RGB") for frame in batch]
        except Exception as decord_exc:  # noqa: BLE001
            # Fallback if decord cannot open the container.
            logger.warning("decord failed (%s); falling back to OpenCV", decord_exc)
            frames = self._load_frames_opencv(path, num_frames=num_frames)
            return frames

        if not frames:
            raise ValueError(f"Failed to decode any frames from: {path}")

        while len(frames) < num_frames:
            frames.append(frames[-1])

        return frames[:num_frames]

    @staticmethod
    def _load_frames_opencv(video_path: str, num_frames: int) -> list[Image.Image]:
        import cv2

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise ValueError(f"Unable to decode video: {video_path}")

        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        collected: list[Image.Image] = []

        if total <= 0:
            while len(collected) < num_frames * 4:
                ok, frame = cap.read()
                if not ok:
                    break
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                collected.append(Image.fromarray(rgb).convert("RGB"))
            cap.release()
            if not collected:
                raise ValueError(f"Video has no frames: {video_path}")
            if len(collected) >= num_frames:
                idxs = np.linspace(0, len(collected) - 1, num_frames).astype(int)
                return [collected[i] for i in idxs]
            while len(collected) < num_frames:
                collected.append(collected[-1])
            return collected[:num_frames]

        if total < num_frames:
            indices = list(range(total))
        else:
            indices = np.linspace(0, total - 1, num_frames).astype(int).tolist()

        for idx in indices:
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(idx))
            ok, frame = cap.read()
            if not ok:
                continue
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            collected.append(Image.fromarray(rgb).convert("RGB"))
        cap.release()

        if not collected:
            raise ValueError(f"Failed to decode any frames from: {video_path}")

        while len(collected) < num_frames:
            collected.append(collected[-1])
        return collected[:num_frames]

    def predict(self, video_path: str | Path) -> dict[str, float]:
        """
        Run VideoMAE deepfake classification.

        Returns:
            {
              "deepfake_probability": float,  # class 1 (fake)
              "real_probability": float,      # class 0 (real)
            }
        """
        if not self.is_ready():
            raise VideoMAENotLoadedError(
                "VideoMAE model is not loaded. Call load_model() during application startup."
            )

        assert self.model is not None and self.processor is not None and self.device is not None

        num_frames = int(self.model_meta.get("num_frames") or NUM_FRAMES)
        frames = self._load_video_frames(video_path, num_frames=num_frames)

        # Processor applies the checkpoint's own resize / normalize config.
        inputs = self.processor(frames, return_tensors="pt")
        inputs = {key: value.to(self.device) for key, value in inputs.items()}

        with torch.no_grad():
            outputs = self.model(**inputs)
            probs = torch.softmax(outputs.logits, dim=-1)[0].detach().cpu()

        if probs.numel() < 2:
            raise RuntimeError(
                f"VideoMAE expected a 2-class head (real/fake); got {probs.numel()} logit(s)."
            )

        # Config: 0=real, 1=fake
        real_probability = float(probs[0].item())
        deepfake_probability = float(probs[1].item())

        if not (0.0 <= real_probability <= 1.0 and 0.0 <= deepfake_probability <= 1.0):
            raise RuntimeError(
                "VideoMAE returned out-of-range probabilities: "
                f"real={real_probability}, deepfake={deepfake_probability}"
            )

        return {
            "deepfake_probability": deepfake_probability,
            "real_probability": real_probability,
        }
