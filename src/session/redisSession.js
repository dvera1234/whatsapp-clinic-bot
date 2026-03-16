import { getRedisClient } from "../redis.js";
import { DEBUG_REDIS, SESSION_TTL_SECONDS } from "../config/env.js";
import { INACTIVITY_WARN_MS, MSG } from "../config/constants.js";
import { errLog, techLog, audit } from "../observability/audit.js";
import { safeJson, safeConsoleWrite } from "../observability/logger.js";
import { maskKey, maskPhone } from "../utils/mask.js";

const redis = getRedisClient();
const inactivityTimers = new Map();

function logRedis(tag, obj) {
  if (!DEBUG_REDIS) return;
  safeConsoleWrite(`[${tag}] ${safeJson(obj)}`);
}

function sessionKey(phone) {
  return `sess:${String(phone || "").replace(/\D+/g, "")}`;
}

function detectUnexpectedSessionKeys(s) {
  const allowed = new Set([
    "state",
    "lastUserTs",
    "lastPhoneNumberIdFallback",
    "booking",
    "portal",
    "pending",
  ]);

  return Object.keys(s || {}).filter((k) => !allowed.has(k));
}

function sanitizeSessionForSave(s) {
  return {
    state: s?.state ?? null,
    lastUserTs: Number(s?.lastUserTs || 0),
    lastPhoneNumberIdFallback: String(s?.lastPhoneNumberIdFallback || ""),
    booking: s?.booking
      ? {
          planoKey: s.booking?.planoKey ?? null,
          codColaborador: Number(s.booking?.codColaborador || 0) || null,
          codUsuario: Number(s.booking?.codUsuario || 0) || null,
          isoDate: s.booking?.isoDate ?? null,
          pageIndex: Number(s.booking?.pageIndex || 0) || 0,
          slots: Array.isArray(s.booking?.slots)
            ? s.booking.slots
                .map((x) => ({
                  codHorario: Number(x?.codHorario || 0) || null,
                  hhmm: x?.hhmm ?? null,
                }))
                .filter((x) => x.codHorario && x.hhmm)
            : [],
          isRetorno: !!s.booking?.isRetorno,
        }
      : null,
    portal: s?.portal
      ? {
          step: s.portal?.step ?? null,
          codUsuario: Number(s.portal?.codUsuario || 0) || null,
          exists: !!s.portal?.exists,
          form: s.portal?.form ?? {},
          missing: Array.isArray(s.portal?.missing) ? s.portal.missing : [],
          issue: s.portal?.issue ?? null,
        }
      : null,
    pending: s?.pending
      ? {
          codHorario: Number(s.pending?.codHorario || 0) || null,
        }
      : null,
  };
}

async function loadSession(phone) {
  const key = sessionKey(phone);
  logRedis("REDIS_GET", { phone: maskPhone(phone), key: maskKey(key) });

  const raw = await redis.get(key);
  if (raw == null) return null;
  if (typeof raw === "object") return raw;

  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch (e) {
      errLog("REDIS_SESSION_CORRUPTED", {
        phoneMasked: maskPhone(phone),
        keyMasked: maskKey(key),
        error: String(e?.message || e),
      });
      await redis.del(key);
      return null;
    }
  }

  return null;
}

async function saveSession(phone, sessionObj) {
  const key = sessionKey(phone);

  const unexpectedKeys = detectUnexpectedSessionKeys(sessionObj);
  if (unexpectedKeys.length) {
    techLog("SESSION_UNEXPECTED_KEYS_DROPPED", {
      phoneMasked: maskPhone(phone),
      unexpectedKeys: unexpectedKeys.slice(0, 20),
    });
  }

  const safeSession = sanitizeSessionForSave(sessionObj);
  const val = JSON.stringify(safeSession);

  logRedis("REDIS_SET", {
    phone: maskPhone(phone),
    key: maskKey(key),
    len: val.length,
  });

  await redis.set(key, val, { ex: SESSION_TTL_SECONDS });
  return true;
}

async function deleteSession(phone) {
  const key = sessionKey(phone);
  await redis.del(key);
}

async function ensureSession(phone) {
  return (
    (await loadSession(phone)) || {
      state: null,
      lastUserTs: 0,
      lastPhoneNumberIdFallback: "",
      booking: null,
      portal: null,
      pending: null,
    }
  );
}

async function updateSession(phone, updater) {
  const s = await ensureSession(phone);
  await updater(s);
  await saveSession(phone, s);
  return s;
}

function clearInactivityTimer(phone) {
  const key = String(phone || "").replace(/\D+/g, "");
  const timer = inactivityTimers.get(key);

  if (timer) {
    clearTimeout(timer);
    inactivityTimers.delete(key);
  }
}

async function clearSession(phone) {
  clearInactivityTimer(phone);
  await deleteSession(phone);
}

// touchUser e scheduleInactivityWarning permanecem iguais,
// apenas injetando sendText ao usar este módulo.
export {
  redis,
  inactivityTimers,
  sessionKey,
  detectUnexpectedSessionKeys,
  sanitizeSessionForSave,
  loadSession,
  saveSession,
  deleteSession,
  ensureSession,
  updateSession,
  clearInactivityTimer,
  clearSession,
};
