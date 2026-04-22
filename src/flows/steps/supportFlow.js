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

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
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
  
  if (upper === "FALAR_ATENDENTE") {
    const sessionObj = await getSession(tenantId, phone);

    const prefill = buildSupportPrefillFromSession(
      runtime,
      phone,
      sessionObj,
      traceId,
      tenantId
    );

    await sendSupportLink({
      tenantId,
      phone,
      phoneNumberId,
      prefill,
      runtime,
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
    const details = readString(raw);

    const prefill = buildSafeSupportPrefill({
      runtime,
      tenantId,
      traceId,
      phone,
      reason: "Dificuldade no agendamento",
      details: details || undefined,
    });

    await sendSupportLink({
      tenantId,
      phone,
      phoneNumberId,
      prefill,
      runtime,
      nextState: "MAIN",
      MSG,
      services,
    });

    await clearTransientPortalData(tenantId, phone);
    return true;
  }

  if (state === "ATENDENTE_DESCRICAO") {
    const details = readString(raw);

    if (!details) {
      await services.sendText({
        tenantId,
        to: phone,
        body: MSG.AJUDA_PERGUNTA,
        phoneNumberId,
      });
      return true;
    }

    const prefill = buildSafeSupportPrefill({
      runtime,
      tenantId,
      traceId,
      phone,
      reason: "Solicitação de atendimento humano",
      details,
    });

    await sendSupportLink({
      tenantId,
      phone,
      phoneNumberId,
      prefill,
      runtime,
      nextState: "MAIN",
      MSG,
      services,
    });

    await clearTransientPortalData(tenantId, phone);
    return true;
  }

  if (allowFreeTextAttendant && state === "ATENDENTE") {
    const details = readString(raw);

    if (!details) {
      await resetToMain(flowCtx);
      return true;
    }

    const prefill = buildSafeSupportPrefill({
      runtime,
      tenantId,
      traceId,
      phone,
      reason: "Solicitação de atendimento humano",
      details,
    });

    await sendSupportLink({
      tenantId,
      phone,
      phoneNumberId,
      prefill,
      runtime,
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
