const { z } = require("zod");

const EnvSchema = z.object({
  PORT: z.coerce.number().default(5000),
  MONGODB_URI: z.string().min(1),
  /** OpenAI API key for POST /api/analyze (keep in .env only; never commit). */
  OPENAI_API_KEY: z.string().optional().default(""),
  /** Chat model for text analysis (e.g. gpt-4o-mini). */
  OPENAI_MODEL: z.string().optional().default("gpt-4o-mini"),
  /** Vision model for POST /api/check-ai (must accept image input, e.g. gpt-4o-mini). */
  OPENAI_VISION_MODEL: z.string().optional().default("gpt-4o-mini"),
  JWT_SECRET: z.string().min(1).default("dev-secret-change-me"),
  CHAIN_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  RPC_URL: z.string().optional().default("http://127.0.0.1:8545"),
  VERITAS_CONTRACT_ADDRESS: z.string().optional().default(""),
  SIGNER_PRIVATE_KEY: z.string().optional().default(""),

  /** Optional: News aggregation APIs (server-side only; never expose to web bundle). */
  NEWSAPI_KEY: z.string().optional().default(""),
  NEWSAPI_KEY_2: z.string().optional().default(""),
  WORLDNEWS_API_KEY: z.string().optional().default(""),
  WORLDNEWS_API_KEY_2: z.string().optional().default(""),
  GNEWS_API_KEY: z.string().optional().default(""),
  GNEWS_API_KEY_2: z.string().optional().default(""),
  THENEWS_API_TOKEN: z.string().optional().default(""),
  THENEWS_API_TOKEN_2: z.string().optional().default(""),
  /** Python video-detector service (AEGIS + VideoMAE). */
  VIDEO_DETECTOR_URL: z.string().optional().default("http://127.0.0.1:5051"),
});

function getEnv() {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return parsed.data;
}

function cleanSecret(v) {
  if (v == null) return "";
  let s = String(v).trim();
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1).trim();
  return s;
}

/** Resolved OpenAI API key from process.env (dotenv) then getEnv() snapshot. */
function resolveOpenAiApiKey(env) {
  const fromProcess = cleanSecret(process.env.OPENAI_API_KEY);
  if (fromProcess) return fromProcess;
  return cleanSecret(env?.OPENAI_API_KEY);
}

module.exports = { getEnv, resolveOpenAiApiKey };
