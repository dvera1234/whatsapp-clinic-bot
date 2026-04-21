import { LOG_LEVEL } from "../config/env.js";
import { nowIso } from "../utils/time.js";
import { sanitizeForLog } from "../utils/logSanitizer.js";

const LOG_RANK = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

const _logRateLimitState = new Map();

function readLogLevel(value) {
  const normalized = String(value || "INFO").trim().toUpperCase();
  return LOG_RANK[normalized] ? normalized : "INFO";
}

function canLog(level) {
  const wanted = LOG_RANK[readLogLevel(level)] ?? LOG_RANK.INFO;
  const current = LOG_RANK[readLogLevel(LOG_LEVEL)] ?? LOG_RANK.INFO;
  return wanted >= current;
}

function safeConsoleWrite(line) {
  try {
    console.log(line);
  } catch (error) {
    try {
      console.error("[LOGGER_FAIL]", String(error?.message || error));
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
  safeConsoleWrite(`[${nowIso()}] [${readLogLevel(level)}] ${tag}${payload}`);
}

function logRateLimited(level, key, tag, obj, minIntervalMs = 60_000) {
  const now = Date.now();
  const previous = _logRateLimitState.get(key);

  if (previous && now - previous.lastMs < minIntervalMs) {
    previous.count += 1;
    _logRateLimitState.set(key, previous);
    return;
  }

  const suppressedCount = previous?.count || 0;

  _logRateLimitState.set(key, {
    lastMs: now,
    count: 0,
  });

  const payload =
    suppressedCount > 0
      ? {
          ...(obj || {}),
          suppressedCountSinceLastLog: suppressedCount,
        }
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
