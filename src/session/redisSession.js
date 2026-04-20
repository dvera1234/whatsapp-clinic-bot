import { redis } from "../redis.js";
import { DEBUG_REDIS, SESSION_TTL_SECONDS } from "../config/env.js";
import { INACTIVITY_WARN_MS } from "../config/constants.js";
import { audit, errLog, techLog } from "../observability/audit.js";
import { safeConsoleWrite, safeJson } from "../observability/logger.js";
import { maskKey, maskPhone } from "../utils/mask.js";

const inactivityTimers = new Map();

let inactivityHandler = {
  sendText: null,
  getMessage: () => "Sessão encerrada por inatividade.",
};

function configureInactivityHandler({ sendText, getMessage } = {}) {
  inactivityHandler.sendText =
    typeof sendText === "function" ? sendText : null;

  if (typeof getMessage === "function") {
    inactivityHandler.getMessage = getMessage;
  }
}

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

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readNullableString(value) {
  const safeValue = readString(value);
  return safeValue || null;
}

function readNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function readBoolean(value) {
  return value === true;
}

function readStringArray(value) {
  if (!Array.isArray(value)) return [];

  return value.map((item) => readString(item)).filter(Boolean);
}

function inactivityTimerKey(tenantId, phone) {
  return `${normalizeTenantId(tenantId)}:${normalizePhone(phone)}`;
}

function sessionKey(tenantId, phone) {
  return `sess:${normalizeTenantId(tenantId)}:${normalizePhone(phone)}`;
}

function detectUnexpectedSessionKeys(sessionObj) {
  const allowedKeys = new Set([
    "state",
    "lastUserTs",
    "lastPhoneNumberId",
    "booking",
    "portal",
    "pending",
  ]);

  return Object.keys(sessionObj || {}).filter((key) => !allowedKeys.has(key));
}

function sanitizeSlot(slot) {
  if (!slot || typeof slot !== "object") return null;

  const slotId = readNumber(slot.slotId);
  const time = readNullableString(slot.time);

  if (slotId === null || !time) return null;

  return {
    slotId,
    time,
  };
}

function sanitizeBooking(booking) {
  if (!booking || typeof booking !== "object") return null;

  const slots = Array.isArray(booking.slots)
    ? booking.slots.map(sanitizeSlot).filter(Boolean)
    : [];

  return {
    planId: readNullableString(booking.planId),
    planKey: readNullableString(booking.planKey),
    planFlow: readNullableString(booking.planFlow),
    planLabel: readNullableString(booking.planLabel),
    planMessageKey: readNullableString(booking.planMessageKey),
    planNextState: readNullableString(booking.planNextState),

    practitionerMode: readNullableString(booking.practitionerMode),
    practitionerIds: readStringArray(booking.practitionerIds),
    practitionerId: readNullableString(booking.practitionerId),

    patientId: readNumber(booking.patientId),
    appointmentDate: readNullableString(booking.appointmentDate),
    selectedDate: readNullableString(booking.selectedDate),

    datePage: readNumber(booking.datePage) ?? 0,
    slotPage: readNumber(booking.slotPage) ?? 0,

    slots,
    selectedSlotId: readNumber(booking.selectedSlotId),
    isReturn: readBoolean(booking.isReturn),
  };
}

function sanitizePortalForm(form) {
  if (!form || typeof form !== "object") return {};

  return {
    document: readNullableString(form.document),
    fullName: readNullableString(form.fullName),
    birthDateISO: readNullableString(form.birthDateISO),
    gender: readNullableString(form.gender),
    email: readNullableString(form.email),
    mobilePhone: readNullableString(form.mobilePhone),
    phone: readNullableString(form.phone),
    postalCode: readNullableString(form.postalCode),
    streetAddress: readNullableString(form.streetAddress),
    addressNumber: readNullableString(form.addressNumber),
    addressComplement: readNullableString(form.addressComplement),
    district: readNullableString(form.district),
    city: readNullableString(form.city),
    stateCode: readNullableString(form.stateCode),
    planId: readNullableString(form.planId),
    planKey: readNullableString(form.planKey),
  };
}

function sanitizePortal(portal) {
  if (!portal || typeof portal !== "object") return null;

  return {
    state: readNullableString(portal.state),
    patientId: readNumber(portal.patientId),
    exists: readBoolean(portal.exists),
    form: sanitizePortalForm(portal.form),
    missing: readStringArray(portal.missing),
    issue: readNullableString(portal.issue),
  };
}

function sanitizePending(pending) {
  if (!pending || typeof pending !== "object") return null;

  return {
    slotId: readNumber(pending.slotId),
  };
}

function sanitizeSessionForSave(sessionObj) {
  return {
    state: readNullableString(sessionObj?.state),
    lastUserTs: readNumber(sessionObj?.lastUserTs) ?? 0,
    lastPhoneNumberId: readString(sessionObj?.lastPhoneNumberId),
    booking: sanitizeBooking(sessionObj?.booking),
    portal: sanitizePortal(sessionObj?.portal),
    pending: sanitizePending(sessionObj?.pending),
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

  if (typeof raw === "object") {
    return sanitizeSessionForSave(raw);
  }

  if (typeof raw === "string") {
    try {
      return sanitizeSessionForSave(JSON.parse(raw));
    } catch (error) {
      errLog("REDIS_SESSION_CORRUPTED", {
        tenantId,
        phoneMasked: maskPhone(phone),
        keyMasked: maskKey(key),
        error: String(error?.message || error),
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
  const value = JSON.stringify(safeSession);

  logRedis("REDIS_SET", {
    tenantId,
    phone: maskPhone(phone),
    key: maskKey(key),
    len: value.length,
  });

  await redis.set(key, value, { ex: SESSION_TTL_SECONDS });
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
      lastPhoneNumberId: "",
      booking: null,
      portal: null,
      pending: null,
    }
  );
}

async function updateSession(tenantId, phone, updater) {
  const sessionObj = await ensureSession(tenantId, phone);
  await updater(sessionObj);
  await saveSession(tenantId, phone, sessionObj);
  return sessionObj;
}

async function setState(tenantId, phone, state) {
  return updateSession(tenantId, phone, (sessionObj) => {
    sessionObj.state = state;
  });
}

async function getState(tenantId, phone) {
  const sessionObj = await loadSession(tenantId, phone);
  return sessionObj?.state || null;
}

async function getSession(tenantId, phone) {
  return ensureSession(tenantId, phone);
}

async function setBookingPlan(tenantId, phone, planInput) {
  return updateSession(tenantId, phone, (sessionObj) => {
    sessionObj.booking = sessionObj.booking || {};

    if (typeof planInput === "string") {
      sessionObj.booking.planKey = planInput;
      return;
    }

    if (!planInput || typeof planInput !== "object") {
      return;
    }

    if ("planId" in planInput) {
      sessionObj.booking.planId = planInput.planId;
    }

    if ("planKey" in planInput) {
      sessionObj.booking.planKey = planInput.planKey;
    }

    if ("planFlow" in planInput) {
      sessionObj.booking.planFlow = planInput.planFlow;
    }

    if ("planLabel" in planInput) {
      sessionObj.booking.planLabel = planInput.planLabel;
    }

    if ("planMessageKey" in planInput) {
      sessionObj.booking.planMessageKey = planInput.planMessageKey;
    }

    if ("planNextState" in planInput) {
      sessionObj.booking.planNextState = planInput.planNextState;
    }

    if ("practitionerMode" in planInput) {
      sessionObj.booking.practitionerMode = planInput.practitionerMode;
    }

    if ("practitionerIds" in planInput) {
      sessionObj.booking.practitionerIds = Array.isArray(planInput.practitionerIds)
        ? planInput.practitionerIds
        : [];
    }

    if ("practitionerId" in planInput) {
      sessionObj.booking.practitionerId = planInput.practitionerId;
    }
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

function scheduleInactivityWarning({ tenantId, phone }) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  const normalizedPhone = normalizePhone(phone);
  const key = inactivityTimerKey(normalizedTenantId, normalizedPhone);

  if (!normalizedTenantId || !normalizedPhone) return;

  clearInactivityTimer(normalizedTenantId, normalizedPhone);

  if (typeof inactivityHandler.sendText !== "function") return;

  const timer = setTimeout(async () => {
    try {
      const sessionObj = await loadSession(normalizedTenantId, normalizedPhone);

      if (!sessionObj) {
        inactivityTimers.delete(key);
        return;
      }

      const idleMs = Date.now() - Number(sessionObj.lastUserTs || 0);

      if (idleMs < INACTIVITY_WARN_MS - 2000) {
        inactivityTimers.delete(key);
        return;
      }

      const message = inactivityHandler.getMessage();

      await inactivityHandler.sendText({
        tenantId: normalizedTenantId,
        to: normalizedPhone,
        body: message,
        phoneNumberId: sessionObj.lastPhoneNumberId || "",
      });

      await clearSession(normalizedTenantId, normalizedPhone);
      inactivityTimers.delete(key);

      audit("FLOW_INACTIVITY_TIMEOUT", {
        tenantId: normalizedTenantId,
        tracePhone: maskPhone(normalizedPhone),
        inactivityMs: idleMs,
        ttlSeconds: SESSION_TTL_SECONDS,
        warningMs: INACTIVITY_WARN_MS,
        functionalResult: "SESSION_CLEARED_AFTER_INACTIVITY",
        patientFacingMessage: "INACTIVITY_CLOSURE_MESSAGE_SENT",
        escalationRequired: false,
      });
    } catch (error) {
      inactivityTimers.delete(key);

      errLog("FLOW_INACTIVITY_TIMEOUT_ERROR", {
        tenantId: normalizedTenantId,
        tracePhone: maskPhone(normalizedPhone),
        error: String(error?.message || error),
      });
    }
  }, INACTIVITY_WARN_MS);

  inactivityTimers.set(key, timer);
}

async function touchUser(arg1, arg2) {
  let tenantId;
  let phone;
  let phoneNumberId;

  if (typeof arg1 === "object" && arg1 !== null) {
    tenantId = arg1.tenantId;
    phone = arg1.phone;
    phoneNumberId = arg1.phoneNumberId;
  } else {
    tenantId = arg1;
    phone = arg2;
  }

  const sessionObj = await updateSession(tenantId, phone, (currentSession) => {
    currentSession.lastUserTs = Date.now();

    if (phoneNumberId) {
      currentSession.lastPhoneNumberId = String(phoneNumberId).trim();
    }
  });

  scheduleInactivityWarning({ tenantId, phone });

  return sessionObj;
}

export {
  configureInactivityHandler,
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
