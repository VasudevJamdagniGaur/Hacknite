"""
Veritas local AI-text detection service (ADAL).

Python 3.11+

  cd text-detector
  pip install -r requirements.txt
  uvicorn app:app --host 0.0.0.0 --port 5052

First run downloads Shushant/ADAL-detector-large via Hugging Face Transformers
into the local HF cache; later runs reuse the cache.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from adal_detector import AdalDetector, AdalNotLoadedError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("veritas-text-detector")

ROOT = Path(__file__).resolve().parent
MODELS_DIR = ROOT / "models"
MODELS_DIR.mkdir(parents=True, exist_ok=True)

_adal: AdalDetector | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Load ADAL once at process start (not per request)."""
    global _adal

    logger.info("Starting Veritas text detector — loading ADAL...")
    detector = AdalDetector(models_dir=MODELS_DIR)
    try:
        detector.load_model()
    except Exception:
        logger.exception("Failed to load ADAL at startup")
        raise
    _adal = detector
    logger.info(
        "Models ready | ADAL=%s | cuda_available=%s",
        _adal.model_meta.get("device"),
        _adal.model_meta.get("cuda_available"),
    )
    yield
    _adal = None


app = FastAPI(
    title="Veritas Text Detector",
    description=(
        "Local ADAL (Shushant/ADAL-detector-large) AI-vs-human text signals. "
        "Outputs are probabilistic estimates — not definitive labels. "
        "No paid inference APIs."
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


@app.exception_handler(HTTPException)
async def http_exception_handler(_request: Request, exc: HTTPException) -> JSONResponse:
    detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
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
            "error": "Internal server error while processing the text.",
        },
    )


def get_adal() -> AdalDetector:
    if _adal is None or not _adal.is_ready():
        raise HTTPException(
            status_code=503,
            detail="ADAL model is not loaded. Service startup may have failed.",
        )
    return _adal


class DetectTextBody(BaseModel):
    text: str = Field(..., description="Text of an X / Twitter post (or any short text).")


@app.get("/health")
def health() -> dict[str, Any]:
    ready = _adal is not None and _adal.is_ready()
    return {
        "status": "ok" if ready else "loading",
        "service": "veritas-text-detector",
        "model": "Shushant/ADAL-detector-large",
        "device": (_adal.model_meta.get("device") if _adal else None),
        "ready": ready,
    }


@app.post("/detect-text")
def detect_text(body: DetectTextBody) -> dict[str, Any]:
    """
    JSON body: ``{"text": "..."}``

    Runs local ADAL inference and returns probabilistic AI/human scores.
    Does not call paid APIs and does not invent random scores.
    """
    raw = body.text
    if raw is None or not str(raw).strip():
        raise HTTPException(
            status_code=400,
            detail="Text is empty. Provide a non-empty 'text' field.",
        )

    try:
        result = get_adal().predict(str(raw))
    except AdalNotLoadedError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("detect-text failed")
        raise HTTPException(
            status_code=500,
            detail=f"Detection failed while analyzing the text: {exc}",
        ) from exc

    return {
        "success": True,
        "ai_probability": float(result["ai_probability"]),
        "human_probability": float(result["human_probability"]),
        "ai_likelihood": int(result["ai_likelihood"]),
        "confidence": result["confidence"],
        "inference_time_ms": float(result["inference_time_ms"]),
        "device": result["device"],
    }
