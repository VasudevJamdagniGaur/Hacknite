"""Build a short MP4 clip from one or more still images for AEGIS/VideoMAE."""

from __future__ import annotations

import base64
import re
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


def _strip_data_url(raw: str) -> bytes:
    s = str(raw or "").strip()
    marker = ";base64,"
    idx = s.lower().find(marker)
    if idx >= 0:
        s = s[idx + len(marker) :]
    elif s.lower().startswith("data:"):
        comma = s.find(",")
        if comma >= 0:
            s = s[comma + 1 :]
    s = re.sub(r"\s+", "", s)
    return base64.b64decode(s, validate=False)


def decode_image_b64(raw: str) -> Image.Image:
    data = _strip_data_url(raw)
    if len(data) < 32:
        raise ValueError("Image payload is empty or too small")
    from io import BytesIO

    img = Image.open(BytesIO(data)).convert("RGB")
    if img.width < 8 or img.height < 8:
        raise ValueError("Image is too small to analyze")
    return img


def load_image_file(path: Path) -> Image.Image:
    img = Image.open(path).convert("RGB")
    if img.width < 8 or img.height < 8:
        raise ValueError("Image is too small to analyze")
    return img


def write_images_to_mp4(
    images: list[Image.Image],
    out_path: Path,
    *,
    num_frames: int = 16,
    fps: float = 8.0,
) -> Path:
    """
    Encode stills as a short MP4.

    If fewer than ``num_frames`` images are provided, the last frame is repeated
    so VideoMAE/AEGIS get a fixed-length clip (no invented pixels).
    """
    if not images:
        raise ValueError("No images to encode")

    frames = list(images)
    while len(frames) < num_frames:
        frames.append(frames[-1])
    frames = frames[:num_frames]

    # Match geometry to first frame; even dims help some codecs.
    w0, h0 = frames[0].size
    w = max(2, w0 - (w0 % 2))
    h = max(2, h0 - (h0 % 2))

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(str(out_path), fourcc, float(fps), (w, h))
    if not writer.isOpened():
        raise RuntimeError(f"Unable to open VideoWriter for {out_path}")

    try:
        for im in frames:
            rgb = np.array(im.convert("RGB"))
            if rgb.shape[1] != w or rgb.shape[0] != h:
                rgb = cv2.resize(rgb, (w, h), interpolation=cv2.INTER_AREA)
            bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
            writer.write(bgr)
    finally:
        writer.release()

    if not out_path.is_file() or out_path.stat().st_size < 256:
        raise RuntimeError("Failed to write screenshot clip")
    return out_path
