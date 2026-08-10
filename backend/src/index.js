const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const { getEnv, resolveOpenAiApiKey } = require("./lib/env");
const { connectDb, isDbReady } = require("./lib/db");
const apiRoutes = require("./routes");

async function main() {
  const env = getEnv();
  const openaiKey = resolveOpenAiApiKey(env);

  if (!openaiKey) {
    // eslint-disable-next-line no-console
    console.warn(
      "[Veritas] No OpenAI key found after loading env files (project .env + backend/.env). Set OPENAI_API_KEY for /api/analyze, /api/check-ai, /api/amazon-review-trust, /api/fact-check, restart this server."
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `[Veritas] OpenAI API key OK (${openaiKey.length} chars; value not printed). Text: POST /api/analyze · Vision: POST /api/check-ai.`
    );
  }

  connectDb(env.MONGODB_URI).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn("MongoDB not available. Running in in-memory fallback mode.");
    // eslint-disable-next-line no-console
    console.warn(e?.message || e);
  });

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "12mb" }));
  app.use(morgan("dev"));

  app.get("/", (_req, res) => res.json({ ok: true, name: "Veritas API" }));
  app.get("/api/health", (_req, res) => {
    const fresh = getEnv();
    const keyOk = Boolean(resolveOpenAiApiKey(fresh));
    res.json({
      ok: true,
      dbReady: isDbReady(),
      openAiConfigured: keyOk,
    });
  });

  app.use("/api", apiRoutes);

  app.use((err, _req, res, _next) => {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  app.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Veritas backend listening on http://localhost:${env.PORT}`);
    // eslint-disable-next-line no-console
    console.log(`  Text analyze: POST http://localhost:${env.PORT}/api/analyze`);
    // eslint-disable-next-line no-console
    console.log(`  Check AI (vision): POST http://localhost:${env.PORT}/api/check-ai`);
    // eslint-disable-next-line no-console
    console.log(`  Amazon review trust: POST http://localhost:${env.PORT}/api/amazon-review-trust`);
    // eslint-disable-next-line no-console
    console.log(`  Amazon per-review scores: POST http://localhost:${env.PORT}/api/amazon-review-scores`);
    // eslint-disable-next-line no-console
    console.log(`  Fact check: POST http://localhost:${env.PORT}/api/fact-check`);
    // eslint-disable-next-line no-console
    console.log(`  Detect video: POST http://localhost:${env.PORT}/api/detect-video`);
    // eslint-disable-next-line no-console
    console.log(`  Video detector upstream: ${env.VIDEO_DETECTOR_URL || "http://127.0.0.1:5051"}`);
    // eslint-disable-next-line no-console
    if (env.PORT === 5000) console.log("Backend running on port 5000");
  });
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
