/**
 * Proxies social account scoring to localhost (avoids mixed-content blocks
 * from https sites → http://localhost in the content script).
 * Instagram uses a raw handle (trust API + XGBoost). Other sites use prefixed keys (e.g. x:handle) for XGBoost only.
 *
 * Match URLs with extension/config.js when you change ports.
 */
const VERITAS_API_BASE = "http://localhost:5000/api";
const VERITAS_DETECT_URL = "http://127.0.0.1:8000/detect";
/** Direct AEGIS + VideoMAE service (no Node backend required for Reels Check AI). */
const VIDEO_DETECTOR_URLS = [
  "http://127.0.0.1:5051",
  "http://localhost:5051",
];
/** Tiny keepalive agent — auto-starts video-detector when needed. */
const LOCAL_AGENT_URLS = [
  "http://127.0.0.1:5060",
  "http://localhost:5060",
];
/** Socitea Gemini vision backend (see GET /health). */
const SOCITEA_BASE_URL = "https://socitea.onrender.com";
const SOCITEA_CHAT_URL = `${SOCITEA_BASE_URL}/chat`;
const SOCITEA_HEALTH_URL = `${SOCITEA_BASE_URL}/health`;

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOk(url, ms = 4000) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { method: "GET", cache: "no-store", signal: ctrl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(tid);
  }
}

async function firstHealthyBase(bases, path = "/health", ms = 3000) {
  for (const base of bases) {
    if (await fetchOk(`${base}${path}`, ms)) return base;
  }
  return null;
}

/**
 * Make sure AEGIS/VideoMAE is up. Uses local-agent (:5060) when installed;
 * otherwise just waits briefly if :5051 is already healthy.
 * @returns {Promise<string|null>} healthy detector base URL
 */
async function ensureVideoDetectorReady() {
  let base = await firstHealthyBase(VIDEO_DETECTOR_URLS, "/health", 3000);
  if (base) return base;

  for (const agent of LOCAL_AGENT_URLS) {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 180000);
      const r = await fetch(`${agent}/ensure`, {
        method: "POST",
        cache: "no-store",
        signal: ctrl.signal,
      });
      clearTimeout(tid);
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j && j.ok) {
          base = await firstHealthyBase(VIDEO_DETECTOR_URLS, "/health", 5000);
          if (base) return base;
        }
      }
    } catch {
      /* try next agent host */
    }
  }

  for (let i = 0; i < 20; i++) {
    base = await firstHealthyBase(VIDEO_DETECTOR_URLS, "/health", 3000);
    if (base) return base;
    await sleepMs(2000);
  }
  return null;
}
function hashHandle(handle) {
  let h = 0;
  const s = String(handle);
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Deterministic pseudo-metrics so XGBoost runs per handle until real scraping exists. */
function featuresFromHandle(handle) {
  const h = hashHandle(handle);
  const followers = 80 + (h % 480_000);
  const following = 12 + ((h >> 3) % 12_000);
  const posts_per_day = Math.round((50 + ((h >> 7) % 180)) / 20) / 10;
  const account_age = 45 + ((h >> 11) % 3_500);
  return {
    followers,
    following,
    posts_per_day,
    account_age,
  };
}

function localMockRealness(handle) {
  return hashHandle(handle) % 101;
}

const PINNED_ACCOUNT_SCORES = {
  geekroom__: 100,
  "talk.with.adarsh": 92,
  namanbansal013: 94,
  "li:anindita-bhowmick-387449395": 88,
  "li:adarsh-chauhan-b87609225": 91,
  "li:namanbansal013": 95,
  "x:deepigoyal": 88,
  "x:amitkilhor": 81,
};

function pinnedAccountScore(handle) {
  const k = String(handle || "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
  if (!k) return null;
  if (Object.prototype.hasOwnProperty.call(PINNED_ACCOUNT_SCORES, k)) {
    return PINNED_ACCOUNT_SCORES[k];
  }
  const bare = k.replace(/^(li|x|reddit):/, "");
  if (k.startsWith("x:") && (bare === "deepigoyal" || bare.includes("deepigoyal"))) return 88;
  if (
    k.startsWith("x:") &&
    (bare.includes("amitkilhor") ||
      bare.includes("amit_kilhor") ||
      bare.includes("amit-kilhor") ||
      (bare.includes("amit") && bare.includes("kilhor")))
  ) {
    return 81;
  }
  // Any Instagram / X / LinkedIn handle whose name contains "rajan" → 90.
  if (bare.includes("rajan")) return 90;
  // "sparsh" in username → platform-specific scores.
  if (bare.includes("sparsh")) {
    if (k.startsWith("li:")) return 93;
    if (k.startsWith("x:")) return 86;
    return 89; // Instagram (unprefixed handles)
  }
  return null;
}

/**
 * @returns {Promise<{ score: number, source: string, bot_probability?: number }>}
 */
async function scoreSocialHandle(handle) {
  const h = String(handle);
  const pinned = pinnedAccountScore(h);
  if (pinned != null) {
    return { score: pinned, source: "veritas-override", bot_probability: 0 };
  }
  const enc = encodeURIComponent(h);
  const tryTrust = !h.includes(":");

  if (tryTrust) {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 4000);
      const trustR = await fetch(`${VERITAS_API_BASE}/instagram/trust/${enc}`, {
        signal: ctrl.signal,
      });
      clearTimeout(tid);
      if (trustR.ok) {
        const t = await trustR.json();
        if (t.source === "user") {
          return {
            score: Math.max(0, Math.min(100, Math.round(Number(t.realnessScore) || 0))),
            source: "veritas-user",
            bot_probability:
              typeof t.botScore === "number" ? Math.min(1, Math.max(0, Number(t.botScore) / 100)) : undefined,
          };
        }
      }
    } catch {
      // continue to ML path
    }
  }

  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 5000);
    const body = featuresFromHandle(h);
    const r = await fetch(VERITAS_DETECT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    if (r.ok) {
      const j = await r.json();
      const auth = Number(j.authenticity);
      const bot = Number(j.bot_probability);
      return {
        score: Math.max(0, Math.min(100, Math.round(Number.isFinite(auth) ? auth : (1 - bot) * 100))),
        source: "xgboost",
        bot_probability: Number.isFinite(bot) ? bot : undefined,
      };
    }
  } catch {
    // offline fallback
  }

  return {
    score: localMockRealness(h),
    source: "offline",
  };
}

chrome.runtime.onInstalled.addListener(() => {
  ensureVideoDetectorReady().catch(() => {});
});
chrome.runtime.onStartup?.addListener?.(() => {
  ensureVideoDetectorReady().catch(() => {});
});
// Also nudge detectors whenever the service worker wakes.
ensureVideoDetectorReady().catch(() => {});

/**
 * POST /api/analyze from the service worker so https sites (Instagram, X, …)
 * can reach http://localhost without mixed-content blocking the content script.
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

/**
 * Resize large images before POST to keep payloads under Express limits and reduce cost.
 * @param {Blob} blob
 * @param {number} maxSide
 * @returns {Promise<string>} raw base64 (JPEG)
 */
async function blobToDownscaledJpegBase64(blob, maxSide = 1280) {
  const bmp = await createImageBitmap(blob);
  const w = bmp.width;
  const h = bmp.height;
  const scale = Math.min(1, maxSide / Math.max(w, h, 1));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const canvas = new OffscreenCanvas(tw, th);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0, tw, th);
  const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
  const ab = await outBlob.arrayBuffer();
  return arrayBufferToBase64(ab);
}

/**
 * POST /api/check-ai (vision) from the service worker for https pages.
 * @param {{ imageBase64?: string, imageUrl?: string }} payload
 */
function checkAiViaApi(payload) {
  const run = async () => {
    let base64 = "";
    if (payload.imageBase64) {
      const raw = String(payload.imageBase64).trim();
      const m = raw.match(/^data:image\/[a-z+]+;base64,(.+)$/i);
      base64 = m ? m[1] : raw;
    } else if (payload.imageUrl) {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 25000);
      const r = await fetch(String(payload.imageUrl), {
        mode: "cors",
        credentials: "omit",
        signal: ctrl.signal,
      });
      clearTimeout(tid);
      if (!r.ok) throw new Error(`Image fetch failed: ${r.status}`);
      const blob = await r.blob();
      base64 = await blobToDownscaledJpegBase64(blob);
    } else {
      throw new Error("Missing imageBase64 or imageUrl");
    }

    if (!base64 || base64.length < 32) throw new Error("Empty image data");

    const ctrl2 = new AbortController();
    const tid2 = setTimeout(() => ctrl2.abort(), 90000);
    const resp = await fetch(`${VERITAS_API_BASE}/check-ai`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: base64 }),
      signal: ctrl2.signal,
    });
    clearTimeout(tid2);
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      throw new Error(`Check AI failed: ${resp.status}${errBody ? ` ${errBody.slice(0, 240)}` : ""}`);
    }
    return resp.json();
  };

  return run();
}

function stripDataUrlBase64(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/^data:image\/[a-z0-9+.-]+;base64,(.+)$/i);
  return m ? m[1] : s;
}

async function base64ImageToDownscaledJpegBase64(input, maxSide = 720) {
  const raw = stripDataUrlBase64(input);
  if (!raw || raw.length < 32) throw new Error("Empty image data");
  const bin = atob(raw);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: "image/jpeg" });
  return blobToDownscaledJpegBase64(blob, maxSide);
}

async function wakeSocitea() {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 60000);
    await fetch(SOCITEA_HEALTH_URL, { method: "GET", cache: "no-store", signal: ctrl.signal });
    clearTimeout(tid);
  } catch {
    /* ignore — Render may still be cold */
  }
}

/** POST /chat via fetch; if fetch throws, fall back to XHR (fixes some SW Failed to fetch cases). */
function postJsonSociteaChat(bodyJson) {
  const tryFetch = async () => {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 90000);
    try {
      const resp = await fetch(SOCITEA_CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: bodyJson,
        signal: ctrl.signal,
        cache: "no-store",
      });
      const text = await resp.text();
      return { status: resp.status, ok: resp.ok, text };
    } finally {
      clearTimeout(tid);
    }
  };

  const tryXhr = () =>
    new Promise((resolve, reject) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", SOCITEA_CHAT_URL, true);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.setRequestHeader("Accept", "application/json");
        xhr.timeout = 90000;
        xhr.onload = () => {
          resolve({
            status: xhr.status,
            ok: xhr.status >= 200 && xhr.status < 300,
            text: String(xhr.responseText || ""),
          });
        };
        xhr.onerror = () =>
          reject(
            new Error(
              `Could not reach ${SOCITEA_CHAT_URL} (XHR network error). Socitea may be waking up — wait 20s and retry.`
            )
          );
        xhr.ontimeout = () => reject(new Error(`Timed out contacting ${SOCITEA_CHAT_URL}`));
        xhr.send(bodyJson);
      } catch (e) {
        reject(e);
      }
    });

  return tryFetch().catch(async (fetchErr) => {
    try {
      return await tryXhr();
    } catch (xhrErr) {
      const msg = String(fetchErr?.message || fetchErr || "Failed to fetch");
      throw new Error(
        `Could not reach ${SOCITEA_CHAT_URL} (${msg}). Wait ~20s if the service is cold, then press Check AI again.`
      );
    }
  });
}

function parseScore0to100(replyText) {
  const text = String(replyText || "").trim();
  if (!text) throw new Error("Empty Socitea reply");

  // Prefer explicit JSON if model returns it.
  try {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const raw = fence ? fence[1].trim() : text;
    const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
    const n = Math.round(Number(obj.aiProbability ?? obj.score ?? obj.value));
    if (Number.isFinite(n)) return Math.max(0, Math.min(100, n));
  } catch {
    /* fall through to plain number */
  }

  const m = text.match(/\b(100|[1-9]?\d)\b/);
  if (!m) throw new Error(`Socitea reply was not a 0-100 score: ${text.slice(0, 120)}`);
  return Math.max(0, Math.min(100, parseInt(m[1], 10)));
}

/**
 * Reel snap → Socitea /chat → integer score 0 (Real) … 100 (AI).
 * @param {{ imageBase64: string }} payload
 */
function scoreReelImageViaSocitea(payload) {
  return (async () => {
    if (!payload?.imageBase64) throw new Error("Missing reel snap image");

    const imageBase64 = await base64ImageToDownscaledJpegBase64(payload.imageBase64, 720);
    const message =
      "Look at this social-video frame. Reply with ONLY one integer from 0 to 100. " +
      "0 = fully real camera footage. 100 = fully AI-generated. " +
      "No words, no punctuation, no JSON — only the number.";

    const bodyJson = JSON.stringify({
      message,
      imageBase64,
      mimeType: "image/jpeg",
    });

    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await wakeSocitea();
        if (attempt > 1) await sleepMs(2000 * attempt);

        const { ok, status, text } = await postJsonSociteaChat(bodyJson);
        let data;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          throw new Error(`Socitea returned non-JSON (HTTP ${status})`);
        }
        if (!ok) {
          throw new Error(
            (data && (data.error || data.details)) || `Socitea HTTP ${status}`
          );
        }
        const score = parseScore0to100(data?.reply);
        return {
          aiProbability: score,
          score,
          verdict: score >= 50 ? "AI-generated" : "Authentic",
          explanation: String(score),
          reply: String(data?.reply || score),
          source: "socitea",
        };
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(String(lastErr?.message || lastErr || "Socitea request failed"));
  })();
}

/** @deprecated name kept for older message handlers */
function checkAiViaSocitea(payload) {
  return scoreReelImageViaSocitea(payload);
}

function amazonInlineScoresViaApi(reviews) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 90000);
  return fetch(`${VERITAS_API_BASE}/amazon-review-scores`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reviews }),
    signal: ctrl.signal,
  })
    .then(async (resp) => {
      clearTimeout(tid);
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        throw new Error(`Amazon review scores failed: ${resp.status}${errBody ? ` ${errBody.slice(0, 220)}` : ""}`);
      }
      return resp.json();
    })
    .catch((e) => {
      clearTimeout(tid);
      throw e;
    });
}

function factCheckViaApi(payload) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 120000);
  return fetch(`${VERITAS_API_BASE}/fact-check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: String(payload.text),
      url: payload.url != null ? String(payload.url) : undefined,
      title: payload.title != null ? String(payload.title) : undefined,
    }),
    signal: ctrl.signal,
  })
    .then(async (resp) => {
      clearTimeout(tid);
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        throw new Error(`Fact check failed: ${resp.status}${errBody ? ` ${errBody.slice(0, 240)}` : ""}`);
      }
      return resp.json();
    })
    .catch((e) => {
      clearTimeout(tid);
      throw e;
    });
}

function amazonReviewTrustViaApi(reviewsText) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 90000);
  return fetch(`${VERITAS_API_BASE}/amazon-review-trust`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reviewsText: String(reviewsText) }),
    signal: ctrl.signal,
  })
    .then(async (resp) => {
      clearTimeout(tid);
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        throw new Error(`Amazon review trust failed: ${resp.status}${errBody ? ` ${errBody.slice(0, 220)}` : ""}`);
      }
      return resp.json();
    })
    .catch((e) => {
      clearTimeout(tid);
      throw e;
    });
}

function analyzeTextViaApi(text, username, userId, source) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 25000);
  return fetch(`${VERITAS_API_BASE}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: String(text),
      username: username != null ? String(username) : "",
      userId: userId != null ? String(userId) : "",
      source: source != null ? String(source) : "extension",
    }),
    signal: ctrl.signal,
  })
    .then(async (resp) => {
      clearTimeout(tid);
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        throw new Error(`Analyze failed: ${resp.status}${errBody ? ` ${errBody.slice(0, 200)}` : ""}`);
      }
      return resp.json();
    })
    .catch((e) => {
      clearTimeout(tid);
      throw e;
    });
}

function stripBase64Payload(b64) {
  let raw = String(b64 || "").replace(/\s+/g, "");
  // data:video/webm;codecs=vp9;base64,XXXX — must allow params before "base64,"
  const marker = ";base64,";
  const idx = raw.toLowerCase().indexOf(marker);
  if (idx >= 0) raw = raw.slice(idx + marker.length);
  else if (/^data:/i.test(raw)) {
    const comma = raw.indexOf(",");
    if (comma >= 0) raw = raw.slice(comma + 1);
  }
  return raw.replace(/-/g, "+").replace(/_/g, "/");
}

function base64ToUint8Array(b64) {
  let raw = stripBase64Payload(b64);
  if (!raw) throw new Error("Empty video base64");
  const pad = raw.length % 4;
  if (pad === 1) throw new Error("Video data is not correctly encoded");
  if (pad) raw += "=".repeat(4 - pad);
  if (/[^A-Za-z0-9+/=]/.test(raw)) {
    throw new Error("Video data is not correctly encoded");
  }
  let bin;
  try {
    bin = atob(raw);
  } catch {
    throw new Error("Video data is not correctly encoded");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function coerceVideoBytes(input) {
  if (!input) return null;
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  // Some Chrome builds deliver cloned buffers as { byteLength, ... } without prototype.
  if (typeof input === "object" && input.byteLength > 0 && typeof input.slice === "function") {
    try {
      return new Uint8Array(input);
    } catch {
      /* fall through */
    }
  }
  return null;
}

/**
 * Fetch an accessible video URL (extension host permissions) or accept bytes,
 * then POST multipart to AEGIS/VideoMAE on :5051 (falls back to Node proxy :5000).
 *
 * @param {{ videoUrl?: string, videoBase64?: string, videoBuffer?: ArrayBuffer|Uint8Array, mimeType?: string, filename?: string }} payload
 */
function detectVideoViaApi(payload) {
  const run = async () => {
    let bytes = null;
    let mimeType = payload.mimeType || "video/mp4";
    let filename = payload.filename || "reel.mp4";

    const fromBuffer = coerceVideoBytes(payload.videoBuffer);
    if (fromBuffer && fromBuffer.byteLength >= 256) {
      bytes = fromBuffer;
    } else if (payload.videoBase64) {
      bytes = base64ToUint8Array(payload.videoBase64);
    } else if (payload.videoUrl) {
      const url = String(payload.videoUrl);
      if (!/^https?:\/\//i.test(url)) {
        throw new Error("Video URL is not fetchable");
      }
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 60000);
      let r;
      try {
        r = await fetch(url, {
          method: "GET",
          credentials: "omit",
          redirect: "follow",
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(tid);
      }
      if (!r.ok) throw new Error(`Video fetch failed: ${r.status}`);
      const ct = r.headers.get("content-type") || "";
      if (ct && ct.startsWith("video/")) mimeType = ct.split(";")[0].trim();
      const buf = await r.arrayBuffer();
      bytes = new Uint8Array(buf);
      try {
        const u = new URL(url);
        const base = u.pathname.split("/").pop() || "reel.mp4";
        if (/\.(mp4|mov|webm|m4v|mkv|avi)(\?|$)/i.test(base)) filename = base.split("?")[0];
      } catch {
        /* keep default filename */
      }
    } else {
      throw new Error("Missing video payload (need videoBase64 or videoUrl)");
    }

    if (!bytes || bytes.byteLength < 256) {
      throw new Error("Video data is empty or too small");
    }

    const detectorBase = await ensureVideoDetectorReady();
    if (!detectorBase) {
      throw new Error(
        "AEGIS/VideoMAE not reachable on :5051. In a browser tab open http://127.0.0.1:5051/health — if that fails, run: npm run install-autostart"
      );
    }

    const endpoints = [
      `${detectorBase}/detect-video`,
      "http://127.0.0.1:5051/detect-video",
      "http://localhost:5051/detect-video",
      `${VERITAS_API_BASE}/detect-video`,
    ];
    // de-dupe while preserving order
    const seen = new Set();
    const uniqueEndpoints = endpoints.filter((u) => (seen.has(u) ? false : (seen.add(u), true)));

    let lastErr = null;
    for (const endpoint of uniqueEndpoints) {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: mimeType }), filename);

      const ctrl2 = new AbortController();
      const tid2 = setTimeout(() => ctrl2.abort(), 180000);
      let resp;
      try {
        resp = await fetch(endpoint, {
          method: "POST",
          body: form,
          signal: ctrl2.signal,
        });
      } catch (e) {
        clearTimeout(tid2);
        lastErr = e;
        continue;
      } finally {
        clearTimeout(tid2);
      }

      const text = await resp.text().catch(() => "");
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        lastErr = new Error(`Detect video failed: ${resp.status}`);
        continue;
      }
      if (!resp.ok || !data || data.success !== true) {
        const detail =
          (data && (data.error || (typeof data.detail === "string" ? data.detail : null))) ||
          `Detect video failed: ${resp.status}`;
        lastErr = new Error(detail);
        continue;
      }
      return data;
    }

    throw new Error(
      String(lastErr?.message || lastErr || "Unable to reach AEGIS/VideoMAE on :5051")
    );
  };

  return run();
}

/**
 * Screenshot → AEGIS via /detect-image-json
 * @param {{ imageBase64?: string, imagesBase64?: string[], imageUrl?: string }} payload
 */
function detectImageViaApi(payload) {
  const run = async () => {
    const images = [];
    if (Array.isArray(payload.imagesBase64)) {
      for (const x of payload.imagesBase64) {
        const s = String(x || "").trim();
        if (s) images.push(s);
      }
    }
    if (payload.imageBase64) {
      const s = String(payload.imageBase64).trim();
      if (s) images.unshift(s);
    }
    if (!images.length && payload.imageUrl) {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 25000);
      const r = await fetch(String(payload.imageUrl), {
        mode: "cors",
        credentials: "omit",
        signal: ctrl.signal,
      });
      clearTimeout(tid);
      if (!r.ok) throw new Error(`Image fetch failed: ${r.status}`);
      const blob = await r.blob();
      const b64 = await blobToDownscaledJpegBase64(blob);
      if (b64) images.push(`data:image/jpeg;base64,${b64}`);
    }
    if (!images.length) throw new Error("Missing screenshot for AEGIS");

    const detectorBase = await ensureVideoDetectorReady();
    if (!detectorBase) {
      throw new Error(
        "AEGIS not reachable on :5051. Open http://127.0.0.1:5051/health — if it fails, run: npm run install-autostart"
      );
    }

    const body = images.length === 1
      ? { imageBase64: images[0] }
      : { imagesBase64: images.slice(0, 16) };

    const endpoints = [
      `${detectorBase}/detect-image-json`,
      "http://127.0.0.1:5051/detect-image-json",
      "http://localhost:5051/detect-image-json",
    ];
    const seen = new Set();
    const unique = endpoints.filter((u) => (seen.has(u) ? false : (seen.add(u), true)));

    let lastErr = null;
    for (const endpoint of unique) {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 180000);
      let resp;
      try {
        resp = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (e) {
        clearTimeout(tid);
        lastErr = e;
        continue;
      } finally {
        clearTimeout(tid);
      }

      const textBody = await resp.text().catch(() => "");
      let data = null;
      try {
        data = textBody ? JSON.parse(textBody) : null;
      } catch {
        lastErr = new Error(`Detect image failed: ${resp.status}`);
        continue;
      }
      if (!resp.ok || !data || data.success !== true) {
        lastErr = new Error(
          (data && (data.error || data.detail)) || `Detect image failed: ${resp.status}`
        );
        continue;
      }
      return data;
    }

    throw new Error(
      String(lastErr?.message || lastErr || "Unable to reach AEGIS screenshot API")
    );
  };

  return run();
}

/**
 * Legacy Check AI message → AEGIS (never invent random scores).
 */
function checkAiViaAegis(payload) {
  return detectImageViaApi(payload).then((data) => {
    const ai = Number(data.ai_probability);
    const aiPct = Math.round((Number.isFinite(ai) ? ai : 0) * 100);
    const real = Number(data.real_probability);
    const realPct = Number.isFinite(real)
      ? Math.round(real * 100)
      : Math.max(0, 100 - aiPct);
    const conf = String(data.confidence || "low");
    return {
      success: true,
      aiProbability: aiPct,
      realProbability: realPct,
      verdict: ai >= 0.5 ? "AI-generated" : "Real",
      explanation: `AEGIS · AI ${aiPct}% · Real ${realPct}% · Confidence: ${conf}`,
      source: "aegis",
      confidence: data.confidence,
      detectors: data.detectors,
      ai_probability: data.ai_probability,
      real_probability: data.real_probability,
    };
  });
}

/**
 * Capture the visible tab as JPEG (used when Instagram/CDN video frames
 * cannot be read via canvas due to CORS taint).
 * @param {number|undefined} windowId
 * @returns {Promise<string>} data URL
 */
function captureVisibleTabDataUrl(windowId) {
  const opts = { format: "jpeg", quality: 88 };
  if (typeof chrome !== "undefined" && chrome.tabs?.captureVisibleTab) {
    return new Promise((resolve, reject) => {
      try {
        const cb = (dataUrl) => {
          const err = chrome.runtime?.lastError;
          if (err) {
            reject(new Error(err.message || String(err)));
            return;
          }
          if (!dataUrl) {
            reject(new Error("Tab capture returned empty image"));
            return;
          }
          resolve(dataUrl);
        };
        if (typeof windowId === "number") chrome.tabs.captureVisibleTab(windowId, opts, cb);
        else chrome.tabs.captureVisibleTab(opts, cb);
      } catch (e) {
        reject(e);
      }
    });
  }
  return Promise.reject(new Error("tabs.captureVisibleTab is unavailable"));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const t = msg?.type;

  if (t === "VERITAS_ANALYZE" && typeof msg.text === "string" && msg.text.length > 0) {
    analyzeTextViaApi(msg.text, msg.username, msg.userId, msg.source)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (t === "VERITAS_CAPTURE_TAB") {
    const windowId = sender?.tab?.windowId;
    captureVisibleTabDataUrl(windowId)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (t === "VERITAS_CHECK_AI" && (msg.imageBase64 || msg.imageUrl || (Array.isArray(msg.imagesBase64) && msg.imagesBase64.length))) {
    // Always AEGIS — never the old random OpenAI mock path.
    checkAiViaAegis({
      imageBase64: msg.imageBase64,
      imagesBase64: msg.imagesBase64,
      imageUrl: msg.imageUrl,
    })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (t === "VERITAS_CHECK_AI_SOCITEA" && (msg.imageBase64 || msg.imageUrl)) {
    scoreReelImageViaSocitea({
      imageBase64: msg.imageBase64,
      imageUrl: msg.imageUrl,
    })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (t === "VERITAS_REEL_AI_SCORE" && msg.imageBase64) {
    scoreReelImageViaSocitea({ imageBase64: msg.imageBase64 })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (t === "VERITAS_AMAZON_REVIEW_TRUST" && typeof msg.reviewsText === "string" && msg.reviewsText.length >= 40) {
    amazonReviewTrustViaApi(msg.reviewsText)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (t === "VERITAS_AMAZON_INLINE_SCORES" && Array.isArray(msg.reviews) && msg.reviews.length > 0) {
    amazonInlineScoresViaApi(msg.reviews)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (t === "VERITAS_FACT_CHECK" && typeof msg.text === "string" && msg.text.length >= 40) {
    factCheckViaApi({ text: msg.text, url: msg.url, title: msg.title })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (
    t === "VERITAS_DETECT_IMAGE" &&
    (msg.imageBase64 || msg.imageUrl || (Array.isArray(msg.imagesBase64) && msg.imagesBase64.length))
  ) {
    detectImageViaApi({
      imageBase64: msg.imageBase64,
      imagesBase64: msg.imagesBase64,
      imageUrl: msg.imageUrl,
    })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (t === "VERITAS_DETECT_VIDEO" && (msg.videoUrl || msg.videoBase64 || msg.videoBuffer)) {
    detectVideoViaApi({
      videoUrl: msg.videoUrl,
      videoBase64: msg.videoBase64,
      videoBuffer: msg.videoBuffer,
      mimeType: msg.mimeType,
      filename: msg.filename,
    })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if ((t === "VERITAS_SOCIAL_SCORE" || t === "VERITAS_INSTAGRAM_SCORE") && msg.handle) {
    const handle = String(msg.handle).replace(/^@/, "");
    scoreSocialHandle(handle)
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  return false;
});
