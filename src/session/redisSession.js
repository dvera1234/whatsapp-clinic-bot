import { getRedisClient } from "../redis.js";
import { DEBUG_REDIS, SESSION_TTL_SECONDS } from "../config/env.js";
import { INACTIVITY_WARN_MS } from "../config/constants.js";
import { audit, errLog, techLog } from "../observability/audit.js";
import { safeConsoleWrite, safeJson } from "../observability/logger.js";
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

async function setState(phone, state) {
  return await updateSession(phone, (s) => {
    s.state = state;
  });
}

async function getState(phone) {
  const s = await loadSession(phone);
  return s?.state || null;
}

async function getSession(phone) {
  return await ensureSession(phone);
}

async function setBookingPlan(phone, planoKey) {
  return await updateSession(phone, (s) => {
    s.booking = { ...(s.booking || {}), planoKey };
  });
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

function scheduleInactivityWarning({ phone, phoneNumberIdFallback, sendText, clearSession, loadSession, msgEncerramento }) {
  const key = String(phone || "").replace(/\D+/g, "");
  if (!key) return;

  clearInactivityTimer(key);

  const timer = setTimeout(async () => {
    try {
      const s = await loadSession(key);

      if (!s) {
        inactivityTimers.delete(key);
        return;
      }

      const idleMs = Date.now() - Number(s.lastUserTs || 0);

      if (idleMs < INACTIVITY_WARN_MS - 2000) {
        inactivityTimers.delete(key);
        return;
      }

      await sendText({
        to: key,
        body: msgEncerramento,
        phoneNumberIdFallback: s.lastPhoneNumberIdFallback || phoneNumberIdFallback || "",
      });

      await clearSession(key);
      inactivityTimers.delete(key);

      audit("FLOW_INACTIVITY_TIMEOUT", {
        tracePhone: maskPhone(key),
        inactivityMs: idleMs,
        ttlSeconds: SESSION_TTL_SECONDS,
        warningMs: INACTIVITY_WARN_MS,
        functionalResult: "SESSION_CLEARED_AFTER_INACTIVITY",
        patientFacingMessage: "INACTIVITY_CLOSURE_MESSAGE_SENT",
        escalationRequired: false,
      });
    } catch (e) {
      inactivityTimers.delete(key);

      errLog("FLOW_INACTIVITY_TIMEOUT_ERROR", {
        tracePhone: maskPhone(key),
        error: String(e?.message || e),
      });
    }
  }, INACTIVITY_WARN_MS);

  inactivityTimers.set(key, timer);
}

async function touchUser({ phone, phoneNumberIdFallback, sendText, msgEncerramento }) {
  const s = await updateSession(phone, (sess) => {
    sess.lastUserTs = Date.now();
    if (phoneNumberIdFallback) sess.lastPhoneNumberIdFallback = phoneNumberIdFallback;
  });

  scheduleInactivityWarning({
    phone,
    phoneNumberIdFallback,
    sendText,
    clearSession,
    loadSession,
    msgEncerramento,
  });

  return s;
}

export {
  redis,
  inactivityTimers,
  logRedis,
  sessionKey,
  detectUnexpectedSessionKeys,
  sanitizeSessionForSave,
  loadSession,
  saveSession,
  deleteSession,
  ensureSession,
  updateSession,
  setState,
  getState,
  getSession,
  setBookingPlan,
  clearInactivityTimer,
  clearSession,
  scheduleInactivityWarning,
  touchUser,
};
