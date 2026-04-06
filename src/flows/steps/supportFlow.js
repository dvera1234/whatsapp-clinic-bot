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

function resolveSupportWa(flowCtx) {
  return (
    flowCtx?.supportWa ||
    flowCtx?.runtime?.support?.waNumber ||
    flowCtx?.runtime?.content?.support?.waNumber ||
    ""
  );
}

export async function handleSupportFlowStep(
  flowCtx,
  { allowFreeTextAttendant = false } = {}
) {
  const {
    tenantId,
    traceId,
    phone,
    phoneNumberId,
    raw,
    upper,
    state,
    MSG,
    services,
    runtime,
  } = flowCtx;

  const supportWa = resolveSupportWa(flowCtx);

  if (upper === "FALAR_ATENDENTE") {
    const s = await getSession(tenantId, phone);
    const prefill = buildSupportPrefillFromSession(phone, s, traceId, tenantId);

    await sendSupportLink({
      tenantId,
      phone,
      ,
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
      phoneNumberId,
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
      phoneNumberId,
      prefill,
      supportWa,
      nextState: "MAIN",
      MSG,
      services,
    });

    await clearTransientPortalData(tenantId, phone);
    return true;
  }

  if (state === "ATENDENTE_DESCRICAO") {
    if (!raw) {
      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.ATTENDANT_DESCRIBE,
        state: "ATENDENTE_DESCRICAO",
        phoneNumberId,
      });
      return true;
    }

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
      phoneNumberId,
      prefill,
      supportWa,
      nextState: "MAIN",
      MSG,
      services,
    });

    await clearTransientPortalData(tenantId, phone);
    return true;
  }

  if (allowFreeTextAttendant && state === "ATENDENTE" && raw) {
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
      phoneNumberId,
      prefill,
      supportWa,
      nextState: "MAIN",
      MSG,
      services,
    });

    await clearTransientPortalData(tenantId, phone);
    return true;
  }

  if (state === "ATENDENTE") {
    await resetToMain(flowCtx);
    return true;
  }

  return false;
}
