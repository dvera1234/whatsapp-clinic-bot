import { nowIso } from "../utils/time.js";
import { safeJson, safeConsoleWrite, canLog } from "./logger.js";
import { sanitizeForLog } from "../utils/logSanitizer.js";

function baseAuditPayload(event, payload = {}) {
  return {
    event,
    ...sanitizeForLog(payload),
  };
}

function writeLog(tag, event, payload = {}) {
  const ts = nowIso();
  safeConsoleWrite(
    `[${ts}] [${tag}] ${safeJson(baseAuditPayload(event, payload))}`
  );
}

function audit(event, payload = {}) {
  writeLog("AUDIT", event, payload);
}

function techLog(event, payload = {}) {
  if (!canLog("WARN")) return;
  writeLog("TECH", event, payload);
}

function opLog(event, payload = {}) {
  writeLog("OP", event, payload);
}

function errLog(event, payload = {}) {
  writeLog("ERROR", event, payload);
}

function debugLog(event, payload = {}) {
  if (!canLog("DEBUG")) return;
  writeLog("DEBUG", event, payload);
}

function auditOutcome(payload = {}) {
  return sanitizeForLog({
    ...payload,
    traceId: payload.traceId || null,
    tracePhone: payload.tracePhone || null,
    rid: payload.rid || null,
    httpStatus: payload.httpStatus ?? null,
    technicalAccepted: !!payload.technicalAccepted,
    functionalResult: payload.functionalResult || null,
    patientFacingMessage: payload.patientFacingMessage || null,
    escalationRequired: !!payload.escalationRequired,
  });
}

export {
  baseAuditPayload,
  writeLog,
  audit,
  techLog,
  opLog,
  errLog,
  debugLog,
  auditOutcome,
};
