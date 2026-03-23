import { clearSession, getSession, setState } from "../../session/redisSession.js";
import {
  LGPD_TEXT_VERSION,
  LGPD_TEXT_HASH,
} from "../../config/constants.js";
import { audit } from "../../observability/audit.js";
import { maskPhone } from "../../utils/mask.js";
import { sendAndSetState, clearTransientPortalData } from "../helpers/flowHelpers.js";
import {
  buildSafeSupportPrefill,
  sendSupportLink,
} from "../helpers/supportHelpers.js";
import { tpl } from "../helpers/contentHelpers.js";
import { formatMissing } from "../helpers/patientHelpers.js";

export async function handlePortalFlowStep(flowCtx) {
  const {
    tenantId,
    traceId,
    phone,
    phoneNumberIdFallback,
    digits,
    state,
    MSG,
    supportWa,
    services,
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
        body: MSG.ASK_CPF_PORTAL,
        state: "WZ_CPF",
        phoneNumberIdFallback,
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
        body: MSG.LGPD_RECUSA,
        phoneNumberIdFallback,
      });

      await clearSession(tenantId, phone);
      return true;
    }

    return false;
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

  return false;
}
