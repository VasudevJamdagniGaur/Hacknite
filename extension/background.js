/**
 * Proxies social account scoring to localhost (avoids mixed-content blocks
 * from https sites → http://localhost in the content script).
 * Instagram uses a raw handle (trust API + XGBoost). Other sites use prefixed keys (e.g. x:handle) for XGBoost only.
 *
 * Match URLs with extension/config.js when you change ports.
 */
const VERITAS_API_BASE = "http://localhost:5000/api";
const VERITAS_DETECT_URL = "http://127.0.0.1:8000/detect";
/** Socitea Gemini vision backend (see GET /health). */
const SOCITEA_BASE_URL = "https://socitea.onrender.com";
const SOCITEA_CHAT_URL = `${SOCITEA_BASE_URL}/chat`;
const SOCITEA_HEALTH_URL = `${SOCITEA_BASE_URL}/health`;

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

/**
 * @returns {Promise<{ score: number, source: string, bot_probability?: number }>}
 */
async function scoreSocialHandle(handle) {
  const h = String(handle);
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

chrome.runtime.onInstalled.addListener(() => {});

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

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function base64ToUint8Array(b64) {
  const raw = String(b64 || "").replace(/^data:[^;]+;base64,/i, "");
  const bin = atob(raw);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Fetch an accessible video URL (extension host permissions) or accept bytes,
 * then POST multipart to /api/detect-video. Does not bypass DRM/CORS via hacks —
 * fetch uses normal extension-allowed networking.
 *
 * @param {{ videoUrl?: string, videoBase64?: string, mimeType?: string, filename?: string }} payload
 */
function detectVideoViaApi(payload) {
  const run = async () => {
    let bytes = null;
    let mimeType = payload.mimeType || "video/mp4";
    let filename = payload.filename || "reel.mp4";

    if (payload.videoBase64) {
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
      throw new Error("Missing videoUrl or videoBase64");
    }

    if (!bytes || bytes.byteLength < 256) {
      throw new Error("Video data is empty or too small");
    }

    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mimeType }), filename);

    const ctrl2 = new AbortController();
    const tid2 = setTimeout(() => ctrl2.abort(), 180000);
    let resp;
    try {
      resp = await fetch(`${VERITAS_API_BASE}/detect-video`, {
        method: "POST",
        body: form,
        signal: ctrl2.signal,
      });
    } finally {
      clearTimeout(tid2);
    }

    const text = await resp.text().catch(() => "");
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Detect video failed: ${resp.status}`);
    }
    if (!resp.ok || !data || data.success !== true) {
      throw new Error(
        (data && (data.error || data.detail)) || `Detect video failed: ${resp.status}`
      );
    }
    return data;
  };

  return run();
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

  if (t === "VERITAS_CHECK_AI" && (msg.imageBase64 || msg.imageUrl)) {
    checkAiViaApi({
      imageBase64: msg.imageBase64,
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

  if (t === "VERITAS_DETECT_VIDEO" && (msg.videoUrl || msg.videoBase64)) {
    detectVideoViaApi({
      videoUrl: msg.videoUrl,
      videoBase64: msg.videoBase64,
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
