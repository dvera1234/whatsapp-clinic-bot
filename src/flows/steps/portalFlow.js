import { clearSession, getSession } from "../../session/redisSession.js";
import { audit } from "../../observability/audit.js";
import { maskPhone } from "../../utils/mask.js";
import {
  sendAndSetState,
  clearTransientPortalData,
} from "../helpers/flowHelpers.js";
import {
  buildSafeSupportPrefill,
  sendSupportLink,
} from "../helpers/supportHelpers.js";
import { setStateAndRender } from "../helpers/stateRenderHelpers.js";

function resolveSupportWa(flowCtx) {
  return (
    flowCtx?.supportWa ||
    flowCtx?.runtime?.support?.waNumber ||
    flowCtx?.runtime?.content?.support?.waNumber ||
    ""
  );
}

function normalizeLgpdChoice({ raw, upper }) {
  const rawValue = String(raw || "").trim().toUpperCase();
  const upperValue = String(upper || "").trim().toUpperCase();

  if (
    rawValue === "LGPD_ACCEPT" ||
    rawValue === "LGPD_ACCEPTED" ||
    rawValue === "LGPD_CONCORDO" ||
    upperValue === "LGPD_ACCEPT" ||
    upperValue === "LGPD_ACCEPTED" ||
    upperValue === "LGPD_CONCORDO"
  ) {
    return "ACCEPT";
  }

  if (
    rawValue === "LGPD_REJECT" ||
    rawValue === "LGPD_REJECTED" ||
    rawValue === "LGPD_NAO_CONCORDO" ||
    rawValue === "LGPD_NÃO_CONCORDO" ||
    upperValue === "LGPD_REJECT" ||
    upperValue === "LGPD_REJECTED" ||
    upperValue === "LGPD_NAO_CONCORDO" ||
    upperValue === "LGPD_NÃO_CONCORDO"
  ) {
    return "REJECT";
  }

  return null;
}

export async function handlePortalFlowStep(flowCtx) {
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

  if (state === "LGPD_CONSENT") {
    const lgpdChoice = normalizeLgpdChoice({ raw, upper });

    if (lgpdChoice === "ACCEPT") {
      audit("LGPD_CONSENT_ACCEPTED", {
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        consent: true,
        timestamp: new Date().toISOString(),
      });

      await sendAndSetState({
        tenantId,
        phone,
        body:
          runtime?.content?.messages?.askCpfPortal ||
          MSG?.ASK_CPF_PORTAL,
        state: "WZ_CPF",
        phoneNumberId,
      });
      return true;
    }

    if (lgpdChoice === "REJECT") {
      audit("LGPD_CONSENT_REFUSED", {
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        consent: false,
        timestamp: new Date().toISOString(),
      });

      await services.sendText({
        tenantId,
        to: phone,
        body:
          runtime?.content?.messages?.lgpdRecusa ||
          MSG?.LGPD_RECUSA,
        phoneNumberId,
      });

      await clearSession(tenantId, phone);
      return true;
    }

    await services.sendText({
      tenantId,
      to: phone,
      body:
        runtime?.content?.messages?.lgpdButtonsOnly ||
        runtime?.content?.messages?.buttonsOnlyWarning ||
        MSG?.LGPD_BUTTONS_ONLY ||
        MSG?.BUTTONS_ONLY_WARNING,
      phoneNumberId,
    });

    await setStateAndRender(flowCtx, "LGPD_CONSENT");
    return true;
  }

  if (state === "BLOCK_EXISTING_INCOMPLETE") {
    const s = await getSession(tenantId, phone);
    const missing = Array.isArray(s?.portal?.missing) ? s.portal.missing : [];
    const supportWa = resolveSupportWa(flowCtx);

    const prefill = buildSafeSupportPrefill({
      tenantId,
      traceId,
      phone,
      reason: "Cadastro incompleto no Portal do Paciente.",
      missing,
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

  return false;
}
