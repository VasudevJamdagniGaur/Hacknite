"""
Veritas video AI detection service.

Python 3.11+

  cd video-detector
  pip install -r requirements.txt
  uvicorn app:app --host 0.0.0.0 --port 5051
"""

from __future__ import annotations

import logging
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from aegis_detector import (
    AegisCUDAUnavailableError,
    AegisDetector,
    AegisNotLoadedError,
)
from image_clip import decode_image_b64, load_image_file, write_images_to_mp4
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("veritas-video-detector")

ROOT = Path(__file__).resolve().parent
UPLOADS_DIR = ROOT / "uploads"
MODELS_DIR = ROOT / "models"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_SUFFIXES = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}
ALLOWED_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
ALLOWED_CONTENT_TYPES = {
    "video/mp4",
    "video/quicktime",
    "video/x-msvideo",
    "video/avi",
    "video/webm",
    "video/x-matroska",
    "video/mpeg",
    "application/octet-stream",  # some browsers omit a precise video MIME
}
ALLOWED_IMAGE_CONTENT_TYPES = {
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/bmp",
    "application/octet-stream",
}

# Request / upload limits (bytes). Override with VIDEO_DETECT_MAX_UPLOAD_MB.
MAX_UPLOAD_BYTES = int(float(os.getenv("VIDEO_DETECT_MAX_UPLOAD_MB", "100")) * 1024 * 1024)
WRITE_CHUNK_BYTES = 1024 * 1024  # 1 MiB

_aegis: AegisDetector | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Load AEGIS once at process start (not per request)."""
    global _aegis

    logger.info("Starting Veritas video detector — loading AEGIS...")
    aegis = AegisDetector(models_dir=MODELS_DIR)
    try:
        aegis.load_model()
    except AegisCUDAUnavailableError as exc:
        logger.error("AEGIS CUDA error during startup: %s", exc)
        raise
    except Exception:
        logger.exception("Failed to load AEGIS at startup")
        raise
    _aegis = aegis

    logger.info(
        "Models ready | AEGIS=%s | max_upload_mb=%.1f",
        _aegis.checkpoint_meta.get("device"),
        MAX_UPLOAD_BYTES / (1024 * 1024),
    )
    yield
    _aegis = None


app = FastAPI(
    title="Veritas Video Detector",
    description=(
        "Probabilistic AEGIS video authenticity signals. "
        "Outputs are confidence-weighted estimates — not definitive labels."
    ),
    version="0.2.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def enforce_content_length_limit(request: Request, call_next):
    """Reject oversized bodies early when Content-Length is present."""
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            length = int(content_length)
        except ValueError:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "Invalid Content-Length header."},
            )
        if length > MAX_UPLOAD_BYTES:
            return JSONResponse(
                status_code=413,
                content={
                    "success": False,
                    "error": (
                        f"Upload exceeds size limit of "
                        f"{MAX_UPLOAD_BYTES // (1024 * 1024)} MB."
                    ),
                },
            )
    return await call_next(request)


@app.exception_handler(HTTPException)
async def http_exception_handler(_request: Request, exc: HTTPException) -> JSONResponse:
    detail = exc.detail
    if not isinstance(detail, str):
        detail = str(detail)
    return JSONResponse(
        status_code=exc.status_code,
        content={"success": False, "error": detail},
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(
    _request: Request, exc: RequestValidationError
) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={"success": False, "error": "Invalid request.", "details": exc.errors()},
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(_request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled error: %s", exc)
    return JSONResponse(
        status_code=500,
        content={
            "success": False,
            "error": "Internal server error while processing the video.",
        },
    )


def get_aegis() -> AegisDetector:
    if _aegis is None or not _aegis.is_ready():
        raise HTTPException(
            status_code=503,
            detail="AEGIS model is not loaded. Service startup may have failed.",
        )
    return _aegis


def _validate_upload_metadata(file: UploadFile) -> str:
    if not file.filename or not file.filename.strip():
        raise HTTPException(status_code=400, detail="Missing filename.")

    # Prevent path traversal from crafted filenames.
    safe_name = Path(file.filename).name
    suffix = Path(safe_name).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported video type '{suffix or '(none)'}'. "
                f"Allowed: {sorted(ALLOWED_SUFFIXES)}"
            ),
        )

    content_type = (file.content_type or "").split(";")[0].strip().lower()
    if content_type and content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported Content-Type '{content_type}'. Expected a video upload.",
        )

    return suffix


async def _save_upload_securely(file: UploadFile, suffix: str) -> Path:
    """
    Stream the upload to a randomized path under uploads/, enforcing size limits.
    """
    dest = UPLOADS_DIR / f"{uuid.uuid4().hex}{suffix}"
    written = 0
    try:
        with dest.open("wb") as out:
            while True:
                chunk = await file.read(WRITE_CHUNK_BYTES)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            f"Upload exceeds size limit of "
                            f"{MAX_UPLOAD_BYTES // (1024 * 1024)} MB."
                        ),
                    )
                out.write(chunk)
    except HTTPException:
        dest.unlink(missing_ok=True)
        raise
    except OSError as exc:
        dest.unlink(missing_ok=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to store upload securely: {exc}",
        ) from exc
    finally:
        await file.close()

    if written == 0:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Empty video upload.")

    # Restrictive permissions where the OS supports them.
    try:
        os.chmod(dest, 0o600)
    except OSError:
        pass

    return dest


def _confidence_from_aegis(ai_p: float) -> str:
    """Simple confidence band from how far AEGIS is from 0.5."""
    dist = abs(float(ai_p) - 0.5)
    if dist >= 0.35:
        return "high"
    if dist >= 0.20:
        return "medium"
    return "low"


def _build_success_response(aegis_result: dict[str, Any]) -> dict[str, Any]:
    """
    Probabilistic AEGIS-only response — never a definitive authenticity claim.
    """
    ai_p = float(aegis_result["ai_generated_probability"])
    real_p = float(aegis_result["real_probability"])
    return {
        "success": True,
        "ai_probability": ai_p,
        "real_probability": real_p,
        "confidence": _confidence_from_aegis(ai_p),
        "detectors": {
            "aegis": {
                "ai_generated_probability": ai_p,
                "real_probability": real_p,
            },
        },
    }


def _run_aegis_detection(video_path: Path) -> dict[str, Any]:
    try:
        aegis_result = get_aegis().predict(video_path)
    except AegisNotLoadedError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except AegisCUDAUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return _build_success_response(aegis_result)


class DetectImageJsonBody(BaseModel):
    """Screenshot / still-frame payload from the Chrome extension."""

    imageBase64: str | None = None
    imagesBase64: list[str] = Field(default_factory=list)


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "veritas-video-detector",
        "model": "aegis",
        "endpoints": "/detect-video,/detect-image,/detect-image-json",
    }


@app.post("/detect-video")
async def detect_video(file: UploadFile = File(...)) -> dict[str, Any]:
    """
    Multipart field name: ``file``

    Runs AEGIS and returns its AI-generated probability.
    Does not return definitive statements such as \"this video is definitely AI\".
    """
    suffix = _validate_upload_metadata(file)
    dest = await _save_upload_securely(file, suffix)

    try:
        return _run_aegis_detection(dest)
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("detect-video failed")
        raise HTTPException(
            status_code=500,
            detail=f"Detection failed while analyzing the upload: {exc}",
        ) from exc
    finally:
        try:
            dest.unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("Failed to delete temp video %s: %s", dest, exc)


@app.post("/detect-image")
async def detect_image(file: UploadFile = File(...)) -> dict[str, Any]:
    """
    Accept a screenshot (multipart ``file``), build a short MP4 of repeated
    frames, then run AEGIS.

    For JSON base64 from the extension, use ``POST /detect-image-json``.
    """
    safe_name = Path(file.filename or "shot.jpg").name
    suffix = Path(safe_name).suffix.lower() or ".jpg"
    if suffix not in ALLOWED_IMAGE_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported image type '{suffix}'. Allowed: {sorted(ALLOWED_IMAGE_SUFFIXES)}",
        )
    content_type = (file.content_type or "").split(";")[0].strip().lower()
    if content_type and content_type not in ALLOWED_IMAGE_CONTENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported Content-Type '{content_type}'. Expected an image upload.",
        )

    img_path = await _save_upload_securely(file, suffix)
    clip_path = UPLOADS_DIR / f"{uuid.uuid4().hex}.mp4"
    try:
        image = load_image_file(img_path)
        write_images_to_mp4([image], clip_path, num_frames=16, fps=8.0)
        result = _run_aegis_detection(clip_path)
        result["input"] = "screenshot"
        return result
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("detect-image failed")
        raise HTTPException(
            status_code=500,
            detail=f"Detection failed while analyzing the screenshot: {exc}",
        ) from exc
    finally:
        for p in (img_path, clip_path):
            try:
                p.unlink(missing_ok=True)
            except OSError as exc:
                logger.warning("Failed to delete temp file %s: %s", p, exc)


@app.post("/detect-image-json")
async def detect_image_json(body: DetectImageJsonBody) -> dict[str, Any]:
    """JSON screenshot path used by the Chrome extension service worker."""
    raw_list = [x for x in (body.imagesBase64 or []) if x]
    if body.imageBase64:
        raw_list = [body.imageBase64, *raw_list]
    if not raw_list:
        raise HTTPException(
            status_code=400,
            detail="Provide imageBase64 or imagesBase64 with at least one screenshot.",
        )
    if len(raw_list) > 16:
        raw_list = raw_list[:16]

    clip_path = UPLOADS_DIR / f"{uuid.uuid4().hex}.mp4"
    try:
        images = [decode_image_b64(x) for x in raw_list]
        write_images_to_mp4(images, clip_path, num_frames=16, fps=8.0)
        result = _run_aegis_detection(clip_path)
        result["input"] = "screenshot" if len(images) == 1 else "screenshots"
        result["frames_used"] = len(images)
        return result
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("detect-image-json failed")
        raise HTTPException(
            status_code=500,
            detail=f"Detection failed while analyzing the screenshot: {exc}",
        ) from exc
    finally:
        try:
            clip_path.unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("Failed to delete temp clip %s: %s", clip_path, exc)
