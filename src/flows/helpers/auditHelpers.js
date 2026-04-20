import { setState } from "../../session/redisSession.js";
import { audit } from "../../observability/audit.js";
import { maskPhone } from "../../utils/mask.js";

const TEMPORARY_PROVIDER_ERROR_CODES = new Set([
  "PROVIDER_CIRCUIT_OPEN",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const TEMPORARY_PROVIDER_HTTP_STATUSES = new Set([429, 502, 503, 504]);

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readErrorCode(err) {
  return readString(err?.code).toUpperCase();
}

function readHttpStatus(err) {
  const candidates = [
    err?.status,
    err?.statusCode,
    err?.httpStatus,
    err?.response?.status,
  ];

  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return null;
}

function readErrorMessage(err) {
  return readString(err?.message || err || "unknown_error");
}

export function isProviderTemporaryUnavailableError(err) {
  if (!err) {
    return false;
  }

  const errorCode = readErrorCode(err);
  if (errorCode && TEMPORARY_PROVIDER_ERROR_CODES.has(errorCode)) {
    return true;
  }

  const httpStatus = readHttpStatus(err);
  if (httpStatus != null && TEMPORARY_PROVIDER_HTTP_STATUSES.has(httpStatus)) {
    return true;
  }

  return false;
}

export async function handleProviderTemporaryUnavailable({
  tenantId,
  traceId = null,
  phone,
  phoneNumberId,
  capability = null,
  err,
  MSG,
  nextState = "MAIN",
  services,
}) {
  const patientMessage = readString(MSG?.providerUnavailable);

  if (!patientMessage) {
    throw new Error("TENANT_CONTENT_MISSING:messages.providerUnavailable");
  }

  audit("PROVIDER_TEMPORARILY_UNAVAILABLE", {
    tenantId,
    traceId,
    tracePhone: maskPhone(phone),
    capability: readString(capability) || null,
    errorCode: readErrorCode(err) || null,
    httpStatus: readHttpStatus(err),
    error: readErrorMessage(err),
    patientMessageSent: true,
    nextState: readString(nextState) || null,
  });

  const sent = await services.sendText({
    tenantId,
    to: phone,
    body: patientMessage,
    phoneNumberId,
  });

  if (!sent) {
    throw new Error("WHATSAPP_SEND_FAILED");
  }

  const normalizedNextState = readString(nextState);
  if (normalizedNextState) {
    await setState(tenantId, phone, normalizedNextState);
  }
}
