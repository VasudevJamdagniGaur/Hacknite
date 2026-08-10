/**
 * Veritas local keepalive — keeps AEGIS/VideoMAE (video-detector :5051) running.
 *
 *   node keepalive.js
 *   POST http://127.0.0.1:5060/ensure  → start detector if needed
 *   GET  http://127.0.0.1:5060/health
 */
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const AGENT_PORT = Number(process.env.VERITAS_AGENT_PORT || 5060);
const DETECTOR_PORT = Number(process.env.VERITAS_DETECTOR_PORT || 5051);
const DETECTOR_URL = `http://127.0.0.1:${DETECTOR_PORT}`;
const ROOT = path.resolve(__dirname, "..");
const DETECTOR_DIR = path.join(ROOT, "video-detector");
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "video-detector.log");

let starting = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function detectorHealthy() {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`${DETECTOR_URL}/health`, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!r.ok) return false;
    const j = await r.json().catch(() => null);
    return j && (j.status === "ok" || j.service === "veritas-video-detector");
  } catch {
    return false;
  }
}

function startDetectorProcess() {
  if (!fs.existsSync(DETECTOR_DIR)) {
    throw new Error(`video-detector folder missing: ${DETECTOR_DIR}`);
  }
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const out = fs.openSync(LOG_FILE, "a");
  const py = process.env.VERITAS_PYTHON || "python";
  // Prefer `python -m uvicorn` so PATH scripts are not required.
  const child = spawn(
    py,
    ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", String(DETECTOR_PORT)],
    {
      cwd: DETECTOR_DIR,
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    }
  );
  child.unref();
  return child.pid;
}

async function ensureDetector() {
  if (await detectorHealthy()) {
    return { ok: true, status: "already_running", url: DETECTOR_URL };
  }
  if (starting) return starting;

  starting = (async () => {
    try {
      const pid = startDetectorProcess();
      // Models can take 30–120s on CPU cold start.
      for (let i = 0; i < 90; i++) {
        await sleep(2000);
        if (await detectorHealthy()) {
          return { ok: true, status: "started", pid, url: DETECTOR_URL };
        }
      }
      return {
        ok: false,
        status: "timeout",
        error: `Detector did not become healthy on :${DETECTOR_PORT}. Check ${LOG_FILE}`,
      };
    } catch (e) {
      return { ok: false, status: "error", error: String(e?.message || e) };
    } finally {
      starting = null;
    }
  })();

  return starting;
}

function sendJson(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(raw);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  const url = String(req.url || "/").split("?")[0];

  if (req.method === "GET" && (url === "/" || url === "/health")) {
    const detector = await detectorHealthy();
    sendJson(res, 200, {
      ok: true,
      service: "veritas-local-agent",
      detector_healthy: detector,
      detector_url: DETECTOR_URL,
    });
    return;
  }

  if (req.method === "POST" && url === "/ensure") {
    const result = await ensureDetector();
    sendJson(res, result.ok ? 200 : 503, result);
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
});

server.listen(AGENT_PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`[veritas-local-agent] listening on http://127.0.0.1:${AGENT_PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[veritas-local-agent] watching detector ${DETECTOR_URL}`);
  // Warm / repair on boot (non-blocking).
  ensureDetector().then((r) => {
    // eslint-disable-next-line no-console
    console.log("[veritas-local-agent] ensure on boot:", r);
  });
});

// Periodic heal every 60s
setInterval(() => {
  ensureDetector().catch(() => {});
}, 60_000);
