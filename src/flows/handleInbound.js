import crypto from "crypto";

import {
  configureInactivityHandler,
  touchUser,
  getState,
} from "../session/redisSession.js";

import { sendText, sendButtons } from "../whatsapp/sender.js";

import {
  FLOW_RESET_CODE,
} from "../config/constants.js";

import { createPatientAdapter } from "../integrations/adapters/factories/createPatientAdapter.js";
import { createPortalAdapter } from "../integrations/adapters/factories/createPortalAdapter.js";
import { createSchedulingAdapter } from "../integrations/adapters/factories/createSchedulingAdapter.js";

import { onlyDigits, normalizeSpaces } from "../utils/validators.js";
import { sanitizeForLog } from "../utils/logSanitizer.js";
import { audit, debugLog } from "../observability/audit.js";
import { maskPhone } from "../utils/mask.js";

import { handleMainMenuStep } from "./steps/mainMenu.js";
import { handlePlanSelectionStep } from "./steps/planSelection.js";
import { handlePatientIdentificationStep } from "./steps/patientIdentification.js";
import { handlePatientRegistrationStep } from "./steps/patientRegistration.js";
import { handleSlotSelectionStep } from "./steps/slotSelection.js";
import { handleBookingConfirmationStep } from "./steps/bookingConfirmation.js";
import { handlePortalFlowStep } from "./steps/portalFlow.js";
import { handleSupportFlowStep } from "./steps/supportFlow.js";
import { handlePostFlowStep } from "./steps/postFlow.js";

import {
  resolveRuntimeFromContext,
  failSafeTenantConfigError,
  sendAndSetState,
} from "./helpers/flowHelpers.js";
import { getFlowText } from "./helpers/contentHelpers.js";

async function handleInbound({
  context = {},
  phone,
  text: inboundText,
  phoneNumberIdFallback,
}) {
  const traceId = String(context?.traceId || crypto.randomUUID());
  const tenantId = String(context?.tenantId || "").trim();
  const effectivePhoneNumberId =
    context?.phoneNumberId || phoneNumberIdFallback || null;

  if (!tenantId) {
    audit("TENANT_CONTEXT_MISSING", {
      traceId,
      tracePhone: maskPhone(phone),
      hasContext: !!context,
      hasPhoneNumberId: !!effectivePhoneNumberId,
      blockedBeforeFlow: true,
    });
    return;
  }

  const runtime = resolveRuntimeFromContext(context);

  if (!runtime) {
    audit("RUNTIME_MISSING_BLOCKED", {
      tenantId,
      traceId,
      tracePhone: maskPhone(phone),
      blockedBeforeFlow: true,
    });

    await failSafeTenantConfigError({
      tenantId,
      phone,
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
    return;
  }

  let MSG;
  try {
    MSG = getFlowText(runtime);
  } catch (err) {
    audit("TENANT_CONTENT_INVALID", {
      tenantId,
      traceId,
      tracePhone: maskPhone(phone),
      error: String(err?.message || err),
      blockedBeforeFlow: true,
    });

    await failSafeTenantConfigError({
      tenantId,
      phone,
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
    return;
  }

  configureInactivityHandler({
    sendText,
    getMessage: () =>
      runtime?.content?.messages?.inactivityClosureMessage ||
      "Sessão encerrada por inatividade.",
  });

  let patientAdapter;
  let portalAdapter;
  let schedulingAdapter;

  try {
    patientAdapter = createPatientAdapter({ tenantId, runtime });
    portalAdapter = createPortalAdapter({ tenantId, runtime });
    schedulingAdapter = createSchedulingAdapter({ tenantId, runtime });
  } catch (err) {
    audit("TENANT_PROVIDER_FACTORY_INIT_FAILED", {
      tenantId,
      traceId,
      tracePhone: maskPhone(phone),
      error: String(err?.message || err),
      blockedBeforeFlow: true,
    });

    await failSafeTenantConfigError({
      tenantId,
      phone,
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
    return;
  }

  const practitionerId = runtime?.clinic?.providerId ?? null;
  const portalUrl = runtime?.portal?.url || "";
  const supportWa = runtime?.support?.waNumber || "";

  const runtimeCtx = {
    tenantId,
    runtime,
    traceId,
    tracePhone: maskPhone(phone),
  };

  const raw = normalizeSpaces(inboundText);
  const upper = String(raw || "").toUpperCase();
  const digits = onlyDigits(raw);

  await touchUser({
    tenantId,
    phone,
    phoneNumberIdFallback: effectivePhoneNumberId,
  });

  const state = (await getState(tenantId, phone)) || "MAIN";

  debugLog(
    "FLOW_INBOUND_RECEIVED",
    sanitizeForLog({
      tenantId,
      traceId,
      phoneMasked: maskPhone(phone),
      state,
      inboundKind: digits ? "digits-or-button" : "text",
    })
  );

  const flowCtx = {
    context,
    tenantId,
    runtime,
    runtimeCtx,
    traceId,
    phone,
    phoneNumberIdFallback: effectivePhoneNumberId,
    raw,
    upper,
    digits,
    state,
    MSG,
    practitionerId,
    portalUrl,
    supportWa,
    adapters: {
      patientAdapter,
      portalAdapter,
      schedulingAdapter,
    },
    services: {
      sendText,
      sendButtons,
    },
  };

  {
    const code = String(FLOW_RESET_CODE || "").trim();
    if (code) {
      const msg = String(raw || "").trim();
      const msgU = msg.toUpperCase();
      const codeU = code.toUpperCase();
      const withHashU = `#${code}`.toUpperCase();

      const hit =
        msgU === codeU ||
        msgU === withHashU ||
        (code.startsWith("#") && msgU === codeU) ||
        (!code.startsWith("#") && msgU === `#${codeU}`);

      if (hit) {
        audit("FLOW_RESET_TRIGGERED", {
          tenantId,
          traceId,
          tracePhone: maskPhone(phone),
          stateBeforeReset: state,
        });

        await sendAndSetState({
          tenantId,
          phone,
          body: MSG.MENU,
          state: "MAIN",
          phoneNumberIdFallback: effectivePhoneNumberId,
          resetSession: true,
        });
        return;
      }
    }
  }

  if (await handlePortalFlowStep(flowCtx)) return;
  if (await handlePlanSelectionStep(flowCtx)) return;
  if (await handleSlotSelectionStep(flowCtx)) return;
  if (await handleBookingConfirmationStep(flowCtx)) return;
  if (await handleSupportFlowStep(flowCtx)) return;

  if (String(state || "").startsWith("WZ_")) {
    if (await handlePatientIdentificationStep(flowCtx)) return;
    if (await handlePatientRegistrationStep(flowCtx)) return;
  }

  if (!digits && !String(state || "").startsWith("WZ_")) {
    if (await handleSupportFlowStep(flowCtx, { allowFreeTextAttendant: true })) {
      return;
    }

    await sendAndSetState({
      tenantId,
      phone,
      body: MSG.MENU,
      state: "MAIN",
      phoneNumberIdFallback: effectivePhoneNumberId,
      clearTransientOnly: true,
    });
    return;
  }

  if (await handleMainMenuStep(flowCtx)) return;
  if (await handlePostFlowStep(flowCtx)) return;

  await sendAndSetState({
    tenantId,
    phone,
    body: MSG.MENU,
    state: "MAIN",
    phoneNumberIdFallback: effectivePhoneNumberId,
  });
}

export { handleInbound };
