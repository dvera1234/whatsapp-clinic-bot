import { setState } from "../../session/redisSession.js";
import { maskPhone } from "../../utils/mask.js";
import { tpl } from "./contentHelpers.js";

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeWhatsAppNumber(value) {
  return String(value || "").replace(/\D+/g, "");
}

function getSupportConfig(runtime) {
  return runtime?.support || {};
}

function resolveSupportWa(runtime) {
  const waNumber = normalizeWhatsAppNumber(getSupportConfig(runtime)?.waNumber);

  if (!waNumber) {
    throw new Error("TENANT_RUNTIME_INVALID:support.waNumber_missing");
  }

  return waNumber;
}

function resolveSupportReason(session) {
  const issueType = readString(session?.portal?.issue?.type);

  if (issueType === "PLAN_NOT_ENABLED") {
    return "Plano não habilitado no cadastro.";
  }

  return "Ajuda no agendamento.";
}

function sanitizeDetails(value, maxLength = 200) {
  return readString(value).slice(0, maxLength);
}

export function makeWaLink(supportWa, prefillText) {
  const normalizedWa = normalizeWhatsAppNumber(supportWa);
  const encodedPrefill = encodeURIComponent(String(prefillText || ""));

  if (!normalizedWa) {
    throw new Error("TENANT_RUNTIME_INVALID:support.waNumber_missing");
  }

  return `https://wa.me/${normalizedWa}?text=${encodedPrefill}`;
}

export async function sendSupportLink({
  tenantId,
  phone,
  phoneNumberId,
  prefill,
  runtime,
  nextState = "MAIN",
  MSG,
  services,
}) {
  const link = makeWaLink(resolveSupportWa(runtime), prefill);
  const messageTemplate = readString(MSG?.supportLinkMessage);

  if (!messageTemplate) {
    throw new Error("TENANT_CONTENT_MISSING:messages.supportLinkMessage");
  }

  const sent = await services.sendText({
    tenantId,
    to: phone,
    body: tpl(messageTemplate, { link }),
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

export function buildSupportPrefillFromSession(
  phone,
  session,
  traceId = null,
  tenantId = null
) {
  const missing = Array.isArray(session?.portal?.missing)
    ? session.portal.missing
    : [];

  return buildSafeSupportPrefill({
    traceId,
    phone,
    reason: resolveSupportReason(session),
    details: sanitizeDetails(session?.portal?.issue?.detail || session?.portal?.issue?.message),
    missing,
  });
}

export function buildSafeSupportPrefill({
  traceId = null,
  phone = "",
  reason = "",
  details = "",
  missing = [],
}) {
  const lines = [
    "Olá! Preciso de ajuda no agendamento.",
    "",
    `Protocolo: ${readString(traceId) || "(não informado)"}`,
    `Paciente: ${maskPhone(phone)}`,
    `Motivo: ${readString(reason) || "Ajuda no agendamento."}`,
  ];

  const normalizedDetails = sanitizeDetails(details);
  if (normalizedDetails) {
    lines.push(`Detalhes: ${normalizedDetails}`);
  }

  const normalizedMissing = (Array.isArray(missing) ? missing : [])
    .map((item) => readString(item))
    .filter(Boolean);

  if (normalizedMissing.length) {
    lines.push(`Pendências: ${normalizedMissing.join(", ")}`);
  }

  return lines.join("\n").trim();
}
