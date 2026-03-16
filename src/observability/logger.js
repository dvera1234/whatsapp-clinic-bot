import { nowIso } from "../utils/time.js";
import { maskPhone, maskIp } from "../utils/mask.js";

const LOG_LEVEL = String(process.env.LOG_LEVEL || "INFO").toUpperCase();
const LOG_RANK = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const _logRL = new Map();

function canLog(level) {
  const want = LOG_RANK[String(level || "INFO").toUpperCase()] ?? 20;
  const have = LOG_RANK[LOG_LEVEL] ?? 20;
  return want >= have;
}

function safeConsoleWrite(line) {
  try {
    console.log(line);
  } catch (e) {
    try {
      console.error("[LOGGER_FAIL]", String(e?.message || e));
    } catch {}
  }
}

function deepSanitizeForLog(value, depth = 0) {
  if (depth > 6) return "[max-depth]";
  if (value == null) return value;

  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return value.map((v) => deepSanitizeForLog(v, depth + 1));
  }

  if (typeof value === "object") {
    const out = {};

    for (const [k, v] of Object.entries(value)) {
      const key = String(k || "").toLowerCase();

      if (
        key.includes("cpf") ||
        key.includes("dtnasc") ||
        key.includes("datanascimento") ||
        key.includes("senha") ||
        key.includes("password") ||
        key.includes("token") ||
        key.includes("authorization") ||
        key.includes("secret") ||
        key.includes("email")
      ) {
        out[k] = "***";
        continue;
      }

      if (
        key.includes("phone") ||
        key.includes("telefone") ||
        key.includes("celular")
      ) {
        out[k] = typeof v === "string" ? maskPhone(v) : "***";
        continue;
      }

      if (key.includes("ip")) {
        out[k] = typeof v === "string" ? maskIp(v) : "***";
        continue;
      }

      out[k] = deepSanitizeForLog(v, depth + 1);
    }

    return out;
  }

  return value;
}

function safeJson(obj) {
  try {
    return JSON.stringify(deepSanitizeForLog(obj));
  } catch {
    return JSON.stringify({ note: "unstringifiable" });
  }
}

function log(level, tag, obj) {
  if (!canLog(level)) return;
  const payload = obj ? ` ${safeJson(obj)}` : "";
  safeConsoleWrite(`[${nowIso()}] [${level}] ${tag}${payload}`);
}

function logRateLimited(level, key, tag, obj, minIntervalMs = 60_000) {
  const now = Date.now();
  const prev = _logRL.get(key);

  if (prev && now - prev.lastMs < minIntervalMs) {
    prev.count++;
    _logRL.set(key, prev);
    return;
  }

  const suppressedCount = prev?.count || 0;
  _logRL.set(key, { lastMs: now, count: 0 });

  const payload =
    suppressedCount > 0
      ? { ...(obj || {}), suppressedCountSinceLastLog: suppressedCount }
      : obj;

  log(level, tag, payload);
}

export {
  canLog,
  safeConsoleWrite,
  deepSanitizeForLog,
  safeJson,
  log,
  logRateLimited,
};
