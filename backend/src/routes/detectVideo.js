const express = require("express");
const multer = require("multer");
const { getEnv } = require("../lib/env");

const router = express.Router();

const MAX_UPLOAD_BYTES = Math.floor(
  Number(process.env.VIDEO_DETECT_MAX_UPLOAD_MB || 100) * 1024 * 1024
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const name = String(file.originalname || "").toLowerCase();
    const okExt = /\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(name);
    const okMime = String(file.mimetype || "").startsWith("video/") || file.mimetype === "application/octet-stream";
    if (okExt || okMime) {
      cb(null, true);
      return;
    }
    cb(new Error("Unsupported video file type"));
  },
});

function videoDetectorBaseUrl() {
  const env = getEnv();
  return String(env.VIDEO_DETECTOR_URL || "http://127.0.0.1:5051").replace(/\/$/, "");
}

/**
 * Proxy multipart video to the Python video-detector service.
 * Never invents scores — forwards the detector response as-is (normalized).
 */
router.post("/", (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) {
      const isSize = err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE";
      return res.status(isSize ? 413 : 400).json({
        success: false,
        error: isSize
          ? `Upload exceeds size limit of ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`
          : err.message || "Invalid video upload",
      });
    }

    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Missing video file. Send multipart field 'file'.",
      });
    }

    const filename = req.file.originalname || "clip.mp4";
    const mime = req.file.mimetype || "video/mp4";
    const base = videoDetectorBaseUrl();

    try {
      const form = new FormData();
      const blob = new Blob([req.file.buffer], { type: mime });
      form.append("file", blob, filename);

      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 180_000);
      let upstream;
      try {
        upstream = await fetch(`${base}/detect-video`, {
          method: "POST",
          body: form,
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(tid);
      }

      const text = await upstream.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        return res.status(502).json({
          success: false,
          error: `Video detector returned non-JSON (HTTP ${upstream.status}).`,
        });
      }

      if (!upstream.ok) {
        let errMsg = data.error;
        if (!errMsg && data.detail != null) {
          errMsg = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
        }
        return res.status(upstream.status === 413 ? 413 : 502).json({
          success: false,
          error: errMsg || `Video detector failed (HTTP ${upstream.status}).`,
        });
      }

      if (!data || data.success !== true) {
        return res.status(502).json({
          success: false,
          error: data?.error || "Video detector did not return a successful result.",
        });
      }

      // Pass through probabilistic fields only — no definitive authenticity claim.
      return res.json({
        success: true,
        ai_probability: Number(data.ai_probability),
        real_probability: Number(data.real_probability),
        confidence: data.confidence,
        detectors: data.detectors,
      });
    } catch (e) {
      const aborted = e?.name === "AbortError";
      // eslint-disable-next-line no-console
      console.error("[detect-video]", e);
      return res.status(aborted ? 504 : 502).json({
        success: false,
        error: aborted
          ? "Video detection timed out."
          : `Unable to reach video detector at ${base}. Is it running?`,
      });
    }
  });
});

module.exports = router;
