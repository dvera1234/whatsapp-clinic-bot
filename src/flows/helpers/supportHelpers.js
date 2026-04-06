import { setState } from "../../session/redisSession.js";
import { maskPhone } from "../../utils/mask.js";
import { tpl } from "./contentHelpers.js";

export function makeWaLink(supportWa, prefillText) {
  const wa = String(supportWa || "").replace(/\D+/g, "");
  const encoded = encodeURIComponent(prefillText);
  return `https://wa.me/${wa}?text=${encoded}`;
}

export async function sendSupportLink({
  tenantId,
  phone,
  phoneNumberId,
  prefill,
  supportWa,
  nextState = "MAIN",
  MSG,
  services,
}) {
  const link = makeWaLink(supportWa, prefill);

  await services.sendText({
    tenantId,
    to: phone,
    body: tpl(MSG.SUPPORT_LINK_MESSAGE, { link }),
    phoneNumberId,
  });

  if (nextState) {
    await setState(tenantId, phone, nextState);
  }
}

export function buildSupportPrefillFromSession(
  phone,
  s,
  traceId = null,
  tenantId = null
) {
  const missing = Array.isArray(s?.portal?.missing) ? s.portal.missing : [];
  const issue = s?.portal?.issue || null;

  const reason =
    issue?.type === "PLAN_NOT_ENABLED"
      ? "Plano desejado não habilitado no cadastro."
      : "Ajuda no agendamento.";

  return buildSafeSupportPrefill({
    tenantId,
    traceId,
    phone,
    reason,
    missing,
  });
}

export function buildSafeSupportPrefill({
  tenantId = null,
  traceId = null,
  phone = "",
  reason = "",
  details = "",
  missing = [],
}) {
  const lines = [
    "Olá! Preciso de ajuda no agendamento.",
    "",
    `Tenant: ${tenantId || "(não informado)"}`,
    `TraceId: ${traceId || "(não informado)"}`,
    `Paciente: ${maskPhone(phone)}`,
    `Motivo: ${reason || "Ajuda no agendamento."}`,
  ];

  if (details) {
    lines.push(`Detalhes: ${String(details).slice(0, 200)}`);
  }

  if (Array.isArray(missing) && missing.length) {
    lines.push(`Pendências: ${missing.join(", ")}`);
  }

  return lines.join("\n").trim();
}
