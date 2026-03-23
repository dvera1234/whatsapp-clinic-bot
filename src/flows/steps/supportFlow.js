import { getSession } from "../../session/redisSession.js";
import {
  clearTransientPortalData,
  resetToMain,
  sendAndSetState,
} from "../helpers/flowHelpers.js";
import {
  buildSafeSupportPrefill,
  buildSupportPrefillFromSession,
  sendSupportLink,
} from "../helpers/supportHelpers.js";

export async function handleSupportFlowStep(
  flowCtx,
  { allowFreeTextAttendant = false } = {}
) {
  const {
    tenantId,
    traceId,
    phone,
    phoneNumberIdFallback,
    raw,
    upper,
    digits,
    state,
    MSG,
    supportWa,
    services,
  } = flowCtx;

  if (upper === "FALAR_ATENDENTE") {
    const s = await getSession(tenantId, phone);
    const prefill = buildSupportPrefillFromSession(phone, s, traceId, tenantId);

    await sendSupportLink({
      tenantId,
      phone,
      phoneNumberIdFallback,
      prefill,
      supportWa,
      nextState: "MAIN",
      MSG,
      services,
    });

    await clearTransientPortalData(tenantId, phone);
    return true;
  }

  if (upper === "AJUDA") {
    await sendAndSetState({
      tenantId,
      phone,
      body: MSG.AJUDA_PERGUNTA,
      state: "WAIT_AJUDA_MOTIVO",
      phoneNumberIdFallback,
    });
    return true;
  }

  if (state === "WAIT_AJUDA_MOTIVO") {
    const prefill = buildSafeSupportPrefill({
      tenantId,
      traceId,
      phone,
      reason: "Paciente relatou dificuldade no agendamento.",
      details: raw,
    });

    await sendSupportLink({
      tenantId,
      phone,
      phoneNumberIdFallback,
      prefill,
      supportWa,
      nextState: "MAIN",
      MSG,
      services,
    });

    await clearTransientPortalData(tenantId, phone);
    return true;
  }

  if (allowFreeTextAttendant && state === "ATENDENTE" && !digits) {
    const prefill = buildSafeSupportPrefill({
      tenantId,
      traceId,
      phone,
      reason: "Paciente solicitou atendimento humano.",
      details: raw,
    });

    await sendSupportLink({
      tenantId,
      phone,
      phoneNumberIdFallback,
      prefill,
      supportWa,
      nextState: "MAIN",
      MSG,
      services,
    });

    await clearTransientPortalData(tenantId, phone);
    return true;
  }

  if (state === "ATENDENTE" && digits === "0") {
    await resetToMain(tenantId, phone, phoneNumberIdFallback, MSG);
    return true;
  }

  if (state === "ATENDENTE" && digits) {
    await sendAndSetState({
      tenantId,
      phone,
      body: MSG.ATTENDANT_DESCRIBE,
      state: "ATENDENTE",
      phoneNumberIdFallback,
    });
    return true;
  }

  return false;
}
