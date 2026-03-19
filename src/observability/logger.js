import { nowIso } from "../utils/time.js";
import { sanitizeForLog } from "../utils/logSanitizer.js";

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
  return sanitizeForLog(value, depth);
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
