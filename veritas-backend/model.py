#!/usr/bin/env python3
"""
Veritas bot/human scorer via XGBoost .

Stdin (one JSON line), mode `predict`:
  - Account features: followers, following, posts_per_day, account_age → XGBoost bot probability
  - Or legacy: { "text": "..." } → simple text heuristic
Stdout: one JSON line.

HTTP (FastAPI): from this directory run
  uvicorn model:app --reload
  POST /detect with JSON body: { "followers", "following", "posts_per_day", "account_age" }
"""
import json
import sys

import numpy as np
import xgboost as xgb
from fastapi import Body, FastAPI, HTTPException

app = FastAPI(title="Veritas detect", version="0.1.0")

_model = xgb.XGBClassifier()
_model.fit(
    np.array([[100, 200, 5, 300], [10, 500, 50, 10]]),
    [0, 1],  # 0=human, 1=bot
)


def predict(data: dict) -> float:
    """Return P(bot) in [0, 1]."""
    features = np.array(
        [
            [
                float(data["followers"]),
                float(data["following"]),
                float(data["posts_per_day"]),
                float(data["account_age"]),
            ]
        ]
    )
    prob = _model.predict_proba(features)[0][1]
    return float(prob)


def score_text(text: str) -> dict:
    """Fallback when only post text is provided (no account features)."""
    t = (text or "").lower().strip()
    if not t:
        return {"score": 0, "label": "empty", "source": "model.py:heuristic"}

    risky = ("breaking", "secret", "they don't want", "miracle", "cure", "hoax")
    score = 72
    if any(w in t for w in risky):
        score = 38
    if len(t) > 400:
        score = max(30, score - 10)

    return {
        "score": max(0, min(100, score)),
        "label": "heuristic",
        "source": "model.py:heuristic",
    }


@app.post("/detect")
def detect(user: dict = Body(...)):
    """JSON body must include followers, following, posts_per_day, account_age."""
    required = ("followers", "following", "posts_per_day", "account_age")
    missing = [k for k in required if k not in user]
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Missing fields: {', '.join(missing)}",
        )
    try:
        score = predict(user)
    except (TypeError, ValueError) as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    return {
        "bot_probability": score,
        "authenticity": (1 - score) * 100,
    }


def main():
    if len(sys.argv) < 2 or sys.argv[1] != "predict":
        print(json.dumps({"error": "usage: model.py predict (stdin JSON)"}))
        sys.exit(1)

    line = sys.stdin.readline()
    try:
        payload = json.loads(line)
    except json.JSONDecodeError:
        print(json.dumps({"error": "invalid json stdin"}))
        sys.exit(1)

    keys = {"followers", "following", "posts_per_day", "account_age"}
    if keys.issubset(payload.keys()):
        try:
            bot_prob = predict(payload)
        except (KeyError, TypeError, ValueError) as e:
            print(json.dumps({"error": "invalid feature values", "detail": str(e)}))
            sys.exit(1)

        human_prob = 1.0 - bot_prob
        out = {
            "bot_probability": round(bot_prob, 6),
            "human_probability": round(human_prob, 6),
            "bot_score_0_100": round(bot_prob * 100, 2),
            "model": "xgboost",
            "source": "model.py",
        }
        print(json.dumps(out), flush=True)
        return

    text = payload.get("text", "")
    if text:
        result = score_text(text)
        print(json.dumps(result), flush=True)
        return

    print(
        json.dumps(
            {
                "error": "Provide either account features "
                "(followers, following, posts_per_day, account_age) or text",
            }
        )
    )
    sys.exit(1)


if __name__ == "__main__":
    main()
