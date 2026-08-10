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
from fusion import fuse_scores
from videomae_detector import VideoMAEDetector, VideoMAENotLoadedError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("veritas-video-detector")

ROOT = Path(__file__).resolve().parent
UPLOADS_DIR = ROOT / "uploads"
MODELS_DIR = ROOT / "models"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_SUFFIXES = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}
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

# Request / upload limits (bytes). Override with VIDEO_DETECT_MAX_UPLOAD_MB.
MAX_UPLOAD_BYTES = int(float(os.getenv("VIDEO_DETECT_MAX_UPLOAD_MB", "100")) * 1024 * 1024)
WRITE_CHUNK_BYTES = 1024 * 1024  # 1 MiB

_aegis: AegisDetector | None = None
_videomae: VideoMAEDetector | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Load AEGIS + VideoMAE once at process start (not per request)."""
    global _aegis, _videomae

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

    logger.info("Loading VideoMAE deepfake detector...")
    videomae = VideoMAEDetector(models_dir=MODELS_DIR)
    try:
        videomae.load_model()
    except Exception:
        logger.exception("Failed to load VideoMAE at startup")
        raise
    _videomae = videomae

    logger.info(
        "Models ready | AEGIS=%s | VideoMAE=%s | max_upload_mb=%.1f",
        _aegis.checkpoint_meta.get("device"),
        _videomae.model_meta.get("device"),
        MAX_UPLOAD_BYTES / (1024 * 1024),
    )
    yield
    _aegis = None
    _videomae = None


app = FastAPI(
    title="Veritas Video Detector",
    description=(
        "Probabilistic AEGIS + VideoMAE video authenticity signals. "
        "Outputs are confidence-weighted estimates — not definitive labels."
    ),
    version="0.1.0",
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


def get_videomae() -> VideoMAEDetector:
    if _videomae is None or not _videomae.is_ready():
        raise HTTPException(
            status_code=503,
            detail="VideoMAE model is not loaded. Service startup may have failed.",
        )
    return _videomae


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


def _build_success_response(
    aegis_result: dict[str, Any],
    videomae_result: dict[str, Any],
    fused: dict[str, Any],
) -> dict[str, Any]:
    """
    Probabilistic response only — never a definitive authenticity claim.
    """
    return {
        "success": True,
        "ai_probability": float(fused["ai_probability"]),
        "real_probability": float(fused["real_probability"]),
        "confidence": fused["confidence"],
        "detectors": {
            "aegis": {
                "ai_generated_probability": float(aegis_result["ai_generated_probability"]),
                "real_probability": float(aegis_result["real_probability"]),
            },
            "videomae": {
                "deepfake_probability": float(videomae_result["deepfake_probability"]),
                "real_probability": float(videomae_result["real_probability"]),
            },
        },
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "veritas-video-detector",
    }


@app.post("/detect-video")
async def detect_video(file: UploadFile = File(...)) -> dict[str, Any]:
    """
    Multipart field name: ``file``

    Runs AEGIS + VideoMAE, fuses probabilistic scores, then deletes the temp file.
    Does not return definitive statements such as \"this video is definitely AI\".
    """
    suffix = _validate_upload_metadata(file)
    dest = await _save_upload_securely(file, suffix)

    try:
        try:
            aegis_result = get_aegis().predict(dest)
        except AegisNotLoadedError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except AegisCUDAUnavailableError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

        try:
            videomae_result = get_videomae().predict(dest)
        except VideoMAENotLoadedError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

        fused = fuse_scores(aegis_result, videomae_result)
        return _build_success_response(aegis_result, videomae_result, fused)

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
