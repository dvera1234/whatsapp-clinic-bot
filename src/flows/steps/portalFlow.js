import { clearSession, getSession } from "../../session/redisSession.js";
import {
  LGPD_TEXT_VERSION,
  LGPD_TEXT_HASH,
} from "../../config/constants.js";
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

export async function handlePortalFlowStep(flowCtx) {
  const {
    tenantId,
    traceId,
    phone,
    phoneNumberId,
    digits,
    state,
    MSG,
    supportWa,
    services,
    runtime,
  } = flowCtx;

  if (state === "LGPD_CONSENT") {
    if (digits === "1") {
      audit("LGPD_CONSENT_ACCEPTED", {
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        consent: true,
        consentTextVersion: LGPD_TEXT_VERSION,
        consentTextHash: LGPD_TEXT_HASH,
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

    if (digits === "2") {
      audit("LGPD_CONSENT_REFUSED", {
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        consent: false,
        consentTextVersion: LGPD_TEXT_VERSION,
        consentTextHash: LGPD_TEXT_HASH,
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
