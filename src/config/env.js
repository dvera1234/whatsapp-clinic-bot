function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`ENV obrigatória ausente: ${name}`);
  }
  return value;
}

function pickToken() {
  return (
    process.env.WHATSAPP_TOKEN ||
    process.env.META_TOKEN ||
    process.env.ACCESS_TOKEN ||
    process.env.FB_TOKEN ||
    process.env.GRAPH_TOKEN ||
    process.env.PERMANENT_TOKEN ||
    ""
  );
}

function pickPhoneNumberId(fallbackFromWebhook) {
  return (
    process.env.WHATSAPP_PHONE_NUMBER_ID ||
    process.env.PHONE_NUMBER_ID ||
    process.env.WA_PHONE_NUMBER_ID ||
    fallbackFromWebhook ||
    ""
  );
}

function readPositiveIntEnv(name, fallback) {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isDebugEnabled() {
  const enabled = String(process.env.ENABLE_DEBUG || "").trim() === "1";
  const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
  return enabled && (nodeEnv === "development" || nodeEnv === "test");
}

function isDebugVersaShapeEnabled() {
  return isDebugEnabled() && String(process.env.DEBUG_VERSA_SHAPE || "").trim() === "1";
}

const PORT = process.env.PORT || 3000;

const VERIFY_TOKEN = requireEnv("VERIFY_TOKEN");
const WHATSAPP_TOKEN = requireEnv("WHATSAPP_TOKEN");
const VERSATILIS_BASE = requireEnv("VERSATILIS_BASE");
const VERSATILIS_USER = requireEnv("VERSATILIS_USER");
const VERSATILIS_PASS = requireEnv("VERSATILIS_PASS");
const UPSTASH_REDIS_REST_URL = requireEnv("UPSTASH_REDIS_REST_URL");
const UPSTASH_REDIS_REST_TOKEN = requireEnv("UPSTASH_REDIS_REST_TOKEN");
const APP_SECRET = requireEnv("APP_SECRET");

const COD_PLANO_PARTICULAR = readPositiveIntEnv("COD_PLANO_PARTICULAR", 0);
const COD_PLANO_MEDSENIOR_SP = readPositiveIntEnv("COD_PLANO_MEDSENIOR_SP", 0);

if (!COD_PLANO_PARTICULAR || !COD_PLANO_MEDSENIOR_SP) {
  throw new Error(
    "ENV obrigatória ausente ou inválida: COD_PLANO_PARTICULAR / COD_PLANO_MEDSENIOR_SP"
  );
}

const COD_UNIDADE = readPositiveIntEnv("COD_UNIDADE", 0);
const COD_ESPECIALIDADE = readPositiveIntEnv("COD_ESPECIALIDADE", 0);
const COD_COLABORADOR = readPositiveIntEnv("COD_COLABORADOR", 0);

if (!COD_UNIDADE || !COD_ESPECIALIDADE || !COD_COLABORADOR) {
  throw new Error(
    "ENV obrigatória ausente ou inválida: COD_UNIDADE / COD_ESPECIALIDADE / COD_COLABORADOR"
  );
}

const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 900);
const FLOW_RESET_CODE = String(process.env.FLOW_RESET_CODE || "").trim();
const DEBUG_REDIS = String(process.env.DEBUG_REDIS || "0").trim() === "1";

export {
  requireEnv,
  pickToken,
  pickPhoneNumberId,
  readPositiveIntEnv,
  isDebugEnabled,
  isDebugVersaShapeEnabled,
  PORT,
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  VERSATILIS_BASE,
  VERSATILIS_USER,
  VERSATILIS_PASS,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  APP_SECRET,
  COD_PLANO_PARTICULAR,
  COD_PLANO_MEDSENIOR_SP,
  COD_UNIDADE,
  COD_ESPECIALIDADE,
  COD_COLABORADOR,
  SESSION_TTL_SECONDS,
  FLOW_RESET_CODE,
  DEBUG_REDIS,
};
