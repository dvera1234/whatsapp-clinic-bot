import { setState } from "../../session/redisSession.js";
import { audit } from "../../observability/audit.js";
import { maskPhone } from "../../utils/mask.js";

export function isProviderTemporaryUnavailableError(err) {
  if (!err) return false;

  if (err?.code === "PROVIDER_CIRCUIT_OPEN") return true;

  const msg = String(err?.message || err).toLowerCase();

  return (
    msg.includes("provider temporarily unavailable") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("504")
  );
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
  audit("PROVIDER_TEMPORARILY_UNAVAILABLE", {
    tenantId,
    traceId,
    tracePhone: maskPhone(phone),
    capability,
    errorCode: err?.code || null,
    error: String(err?.message || err || "unknown_error"),
    patientMessageSent: true,
  });

  await services.sendText({
    tenantId,
    to: phone,
    body: MSG.PROVIDER_UNAVAILABLE,
    phoneNumberId,
  });

  if (nextState) {
    await setState(tenantId, phone, nextState);
  }
}
