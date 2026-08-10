"""
Veritas conservative fusion of AEGIS + VideoMAE scores.

Scope (do not over-claim):
  - AEGIS: trained for *fully AI-generated* video (Sora/Kling/Runway-style),
    not a general detector of every synthetic medium.
  - VideoMAE: fine-tuned mainly for *facial / deepfake* manipulation
    (e.g. FaceForensics++), not full generative video or all AIGC.

Fusion therefore treats each score as a *partial* signal and becomes less
confident when the detectors disagree substantially.
"""

from __future__ import annotations

from typing import Any, Literal

Confidence = Literal["low", "medium", "high"]

# Thresholds for "strong" per-detector signals
AEGIS_STRONG = 0.85
AEGIS_ELEVATED = 0.70
VIDEOMAE_STRONG = 0.85
VIDEOMAE_ELEVATED = 0.70

# Disagreement bands (|aegis - videomae|)
DISAGREE_HIGH = 0.40
DISAGREE_MED = 0.25


def _clamp01(x: float) -> float:
    return float(max(0.0, min(1.0, x)))


def fuse(
    aegis_ai_probability: float,
    videomae_deepfake_probability: float,
) -> dict[str, Any]:
    """
    Conservatively combine detector probabilities.

    Parameters
    ----------
    aegis_ai_probability:
        P(fully AI-generated) from AEGIS.
    videomae_deepfake_probability:
        P(facial deepfake / manipulation) from VideoMAE.

    Returns
    -------
    dict with:
      ai_probability, real_probability, confidence, detector_results
    """
    aegis_p = _clamp01(float(aegis_ai_probability))
    videomae_p = _clamp01(float(videomae_deepfake_probability))
    disagreement = abs(aegis_p - videomae_p)

    # Neutral starting blend — neither model covers all synthetic media alone.
    ai = 0.5 * aegis_p + 0.5 * videomae_p
    rationale: list[str] = [
        "Base blend is a cautious average; neither detector covers every synthetic form."
    ]

    # Strong / elevated AEGIS → increase AI likelihood.
    # Low VideoMAE must not veto this: face-centric VideoMAE can miss full generative video.
    if aegis_p >= AEGIS_STRONG:
        boosted = 0.75 * aegis_p + 0.25 * ai
        ai = max(ai, boosted)
        rationale.append(
            f"AEGIS strongly indicates fully AI-generated video ({aegis_p:.3f}); "
            "raising AI likelihood (VideoMAE is not designed to refute full generative video)."
        )
    elif aegis_p >= AEGIS_ELEVATED:
        boosted = 0.60 * aegis_p + 0.40 * ai
        ai = max(ai, boosted)
        rationale.append(
            f"AEGIS elevated AI-generation signal ({aegis_p:.3f}); modestly raising AI likelihood."
        )

    # Strong / elevated VideoMAE → increase AI/manipulation likelihood.
    # Low AEGIS must not veto this: AEGIS targets full generative video, not face-swaps.
    if videomae_p >= VIDEOMAE_STRONG:
        boosted = 0.75 * videomae_p + 0.25 * ai
        ai = max(ai, boosted)
        rationale.append(
            f"VideoMAE strongly indicates facial/deepfake manipulation ({videomae_p:.3f}); "
            "raising AI/manipulation likelihood (AEGIS is not a face-swap specialist)."
        )
    elif videomae_p >= VIDEOMAE_ELEVATED:
        boosted = 0.60 * videomae_p + 0.40 * ai
        ai = max(ai, boosted)
        rationale.append(
            f"VideoMAE elevated deepfake signal ({videomae_p:.3f}); modestly raising AI/manipulation likelihood."
        )

    # Substantial disagreement → shrink certainty toward undecided; never claim high confidence.
    if disagreement >= DISAGREE_HIGH:
        ai = 0.60 * ai + 0.40 * 0.5
        confidence: Confidence = "low"
        rationale.append(
            f"Detectors disagree substantially (abs_diff={disagreement:.3f}); "
            "regressing toward uncertainty and marking confidence=low."
        )
    elif disagreement >= DISAGREE_MED:
        ai = 0.80 * ai + 0.20 * 0.5
        strength = abs(ai - 0.5)
        confidence = "medium" if strength >= 0.22 else "low"
        rationale.append(
            f"Moderate detector disagreement (abs_diff={disagreement:.3f}); "
            f"damping certainty (confidence={confidence})."
        )
    else:
        strength = abs(ai - 0.5)
        if strength >= 0.35 and disagreement < 0.15:
            confidence = "high"
        elif strength >= 0.20:
            confidence = "medium"
        else:
            confidence = "low"
        rationale.append(
            f"Detectors roughly agree (abs_diff={disagreement:.3f}); "
            f"confidence={confidence} from fused strength={strength:.3f}."
        )

    # Never allow "high" confidence under large disagreement (safety clamp).
    if disagreement >= DISAGREE_MED and confidence == "high":
        confidence = "medium"

    ai = _clamp01(ai)
    real = _clamp01(1.0 - ai)

    return {
        "ai_probability": ai,
        "real_probability": real,
        "confidence": confidence,
        "detector_results": {
            "aegis": {
                "ai_generated_probability": aegis_p,
                "real_probability": _clamp01(1.0 - aegis_p),
                "role": "fully_ai_generated_video",
                "scope_note": (
                    "Detects fully AI-generated video. "
                    "Not a complete detector for all synthetic or edited media."
                ),
            },
            "videomae": {
                "deepfake_probability": videomae_p,
                "real_probability": _clamp01(1.0 - videomae_p),
                "role": "facial_deepfake_manipulation",
                "scope_note": (
                    "Primarily detects facial/deepfake manipulation. "
                    "Not a complete detector for full generative video or all AIGC."
                ),
            },
            "disagreement": round(disagreement, 6),
            "fusion_notes": rationale,
        },
    }


def fuse_scores(
    aegis_result: dict[str, Any] | None,
    videomae_result: dict[str, Any] | None,
) -> dict[str, Any]:
    """
    Adapter used by the FastAPI service.

    Extracts official detector probabilities and runs ``fuse()``.
    Does not invent missing scores.
    """
    if not aegis_result or "ai_generated_probability" not in aegis_result:
        raise ValueError("AEGIS result missing ai_generated_probability")
    if not videomae_result or "deepfake_probability" not in videomae_result:
        raise ValueError("VideoMAE result missing deepfake_probability")

    return fuse(
        aegis_ai_probability=float(aegis_result["ai_generated_probability"]),
        videomae_deepfake_probability=float(videomae_result["deepfake_probability"]),
    )
