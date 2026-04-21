function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`ENV obrigatória ausente: ${name}`);
  }
  return value;
}

function readPositiveIntEnv(name, fallback) {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isDebugEnabled() {
  return String(process.env.ENABLE_DEBUG || "").trim() === "1";
}

function isDebugVersaShapeEnabled() {
  return (
    isDebugEnabled() &&
    String(process.env.DEBUG_VERSA_SHAPE || "").trim() === "1"
  );
}

const PORT = process.env.PORT || 3000;

// 🔒 core system env
const VERIFY_TOKEN = requireEnv("VERIFY_TOKEN");
const UPSTASH_REDIS_REST_URL = requireEnv("UPSTASH_REDIS_REST_URL");
const UPSTASH_REDIS_REST_TOKEN = requireEnv("UPSTASH_REDIS_REST_TOKEN");
const APP_SECRET = requireEnv("APP_SECRET");

// ⚠️ IMPORTANTE
// removido WHATSAPP_TOKEN global → deve vir por tenant/channel

const DATABASE_URL = requireEnv("DATABASE_URL");

const SESSION_TTL_SECONDS = readPositiveIntEnv(
  "SESSION_TTL_SECONDS",
  900
);

const FLOW_RESET_CODE = String(process.env.FLOW_RESET_CODE || "").trim();

const DEBUG_REDIS =
  String(process.env.DEBUG_REDIS || "0").trim() === "1";

export {
  requireEnv,
  readPositiveIntEnv,
  isDebugEnabled,
  isDebugVersaShapeEnabled,
  PORT,
  VERIFY_TOKEN,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  APP_SECRET,
  DATABASE_URL,
  SESSION_TTL_SECONDS,
  FLOW_RESET_CODE,
  DEBUG_REDIS,
};
