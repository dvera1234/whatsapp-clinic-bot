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

function normalizeTenantId(tenantId) {
  return String(tenantId || "").trim();
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D+/g, "");
}

function inactivityTimerKey(tenantId, phone) {
  return `${normalizeTenantId(tenantId)}:${normalizePhone(phone)}`;
}

function sessionKey(tenantId, phone) {
  return `sess:${normalizeTenantId(tenantId)}:${normalizePhone(phone)}`;
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

async function loadSession(tenantId, phone) {
  const key = sessionKey(tenantId, phone);

  logRedis("REDIS_GET", {
    tenantId,
    phone: maskPhone(phone),
    key: maskKey(key),
  });

  const raw = await redis.get(key);

  if (raw == null) return null;
  if (typeof raw === "object") return raw;

  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch (e) {
      errLog("REDIS_SESSION_CORRUPTED", {
        tenantId,
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

async function saveSession(tenantId, phone, sessionObj) {
  const key = sessionKey(tenantId, phone);

  const unexpectedKeys = detectUnexpectedSessionKeys(sessionObj);
  if (unexpectedKeys.length) {
    techLog("SESSION_UNEXPECTED_KEYS_DROPPED", {
      tenantId,
      phoneMasked: maskPhone(phone),
      unexpectedKeys: unexpectedKeys.slice(0, 20),
    });
  }

  const safeSession = sanitizeSessionForSave(sessionObj);
  const val = JSON.stringify(safeSession);

  logRedis("REDIS_SET", {
    tenantId,
    phone: maskPhone(phone),
    key: maskKey(key),
    len: val.length,
  });

  await redis.set(key, val, { ex: SESSION_TTL_SECONDS });
  return true;
}

async function deleteSession(tenantId, phone) {
  const key = sessionKey(tenantId, phone);
  await redis.del(key);
}

async function ensureSession(tenantId, phone) {
  return (
    (await loadSession(tenantId, phone)) || {
      state: null,
      lastUserTs: 0,
      lastPhoneNumberIdFallback: "",
      booking: null,
      portal: null,
      pending: null,
    }
  );
}

async function updateSession(tenantId, phone, updater) {
  const s = await ensureSession(tenantId, phone);
  await updater(s);
  await saveSession(tenantId, phone, s);
  return s;
}

async function setState(tenantId, phone, state) {
  return await updateSession(tenantId, phone, (s) => {
    s.state = state;
  });
}

async function getState(tenantId, phone) {
  const s = await loadSession(tenantId, phone);
  return s?.state || null;
}

async function getSession(tenantId, phone) {
  return await ensureSession(tenantId, phone);
}

async function setBookingPlan(tenantId, phone, planoKey) {
  return await updateSession(tenantId, phone, (s) => {
    s.booking = { ...(s.booking || {}), planoKey };
  });
}

function clearInactivityTimer(tenantId, phone) {
  const key = inactivityTimerKey(tenantId, phone);
  const timer = inactivityTimers.get(key);

  if (timer) {
    clearTimeout(timer);
    inactivityTimers.delete(key);
  }
}

async function clearSession(tenantId, phone) {
  clearInactivityTimer(tenantId, phone);
  await deleteSession(tenantId, phone);
}

function scheduleInactivityWarning({
  tenantId,
  phone,
  phoneNumberIdFallback,
  sendText,
  msgEncerramento,
}) {
  const normalizedPhone = normalizePhone(phone);
  const timerKey = inactivityTimerKey(tenantId, normalizedPhone);

  if (!tenantId || !normalizedPhone) return;

  clearInactivityTimer(tenantId, normalizedPhone);

  if (typeof sendText !== "function" || !msgEncerramento) {
    return;
  }

  const timer = setTimeout(async () => {
    try {
      const s = await loadSession(tenantId, normalizedPhone);

      if (!s) {
        inactivityTimers.delete(timerKey);
        return;
      }

      const idleMs = Date.now() - Number(s.lastUserTs || 0);

      if (idleMs < INACTIVITY_WARN_MS - 2000) {
        inactivityTimers.delete(timerKey);
        return;
      }

      await sendText({
        tenantId,
        to: normalizedPhone,
        body: msgEncerramento,
        phoneNumberIdFallback:
          s.lastPhoneNumberIdFallback || phoneNumberIdFallback || "",
      });

      await clearSession(tenantId, normalizedPhone);
      inactivityTimers.delete(timerKey);

      audit("FLOW_INACTIVITY_TIMEOUT", {
        tenantId,
        tracePhone: maskPhone(normalizedPhone),
        inactivityMs: idleMs,
        ttlSeconds: SESSION_TTL_SECONDS,
        warningMs: INACTIVITY_WARN_MS,
        functionalResult: "SESSION_CLEARED_AFTER_INACTIVITY",
        patientFacingMessage: "INACTIVITY_CLOSURE_MESSAGE_SENT",
        escalationRequired: false,
      });
    } catch (e) {
      inactivityTimers.delete(timerKey);

      errLog("FLOW_INACTIVITY_TIMEOUT_ERROR", {
        tenantId,
        tracePhone: maskPhone(normalizedPhone),
        error: String(e?.message || e),
      });
    }
  }, INACTIVITY_WARN_MS);

  inactivityTimers.set(timerKey, timer);
}

async function touchUser(arg1, arg2) {
  let tenantId;
  let phone;
  let phoneNumberIdFallback;
  let sendText;
  let msgEncerramento;

  if (typeof arg1 === "object" && arg1 !== null) {
    tenantId = arg1.tenantId;
    phone = arg1.phone;
    phoneNumberIdFallback = arg1.phoneNumberIdFallback;
    sendText = arg1.sendText;
    msgEncerramento = arg1.msgEncerramento;
  } else {
    tenantId = arg1;
    phone = arg2;
  }

  const s = await updateSession(tenantId, phone, (sess) => {
    sess.lastUserTs = Date.now();
    if (phoneNumberIdFallback) {
      sess.lastPhoneNumberIdFallback = phoneNumberIdFallback;
    }
  });

  scheduleInactivityWarning({
    tenantId,
    phone,
    phoneNumberIdFallback,
    sendText,
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
