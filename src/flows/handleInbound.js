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
    });
    return;
  }

  const runtime = resolveRuntimeFromContext(context);

  if (!runtime) {
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
    await failSafeTenantConfigError({
      tenantId,
      phone,
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
    return;
  }

  // ✅ INATIVIDADE 100% JSON (SEM FALLBACK)
  configureInactivityHandler({
    sendText,
    getMessage: () => runtime.content.messages.inactivityClosureMessage,
  });

  let patientAdapter;
  let portalAdapter;
  let schedulingAdapter;

  try {
    patientAdapter = createPatientAdapter({ tenantId, runtime });
    portalAdapter = createPortalAdapter({ tenantId, runtime });
    schedulingAdapter = createSchedulingAdapter({ tenantId, runtime });
  } catch (err) {
    await failSafeTenantConfigError({
      tenantId,
      phone,
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
    return;
  }

  const practitionerId = runtime?.clinic?.providerId ?? null;

  const raw = normalizeSpaces(inboundText);
  const upper = String(raw || "").toUpperCase();
  const digits = onlyDigits(raw);

  await touchUser({
    tenantId,
    phone,
    phoneNumberIdFallback: effectivePhoneNumberId,
  });

  const state = (await getState(tenantId, phone)) || "MAIN";

  const flowCtx = {
    context,
    tenantId,
    runtime,
    traceId,
    phone,
    phoneNumberIdFallback: effectivePhoneNumberId,
    raw,
    upper,
    digits,
    state,
    MSG,
    practitionerId,
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

  // RESET
  {
    const code = String(FLOW_RESET_CODE || "").trim();
    if (code && raw.toUpperCase() === code.toUpperCase()) {
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

  // ✅ ORDEM CORRETA — ORQUESTRADOR PURO

  if (await handleMainMenuStep(flowCtx)) return;

  if (await handlePlanSelectionStep(flowCtx)) return;

  if (await handlePortalFlowStep(flowCtx)) return;

  if (await handlePatientIdentificationStep(flowCtx)) return;

  if (await handlePatientRegistrationStep(flowCtx)) return;

  if (await handleSlotSelectionStep(flowCtx)) return;

  if (await handleBookingConfirmationStep(flowCtx)) return;

  if (await handlePostFlowStep(flowCtx)) return;

  if (await handleSupportFlowStep(flowCtx)) return;

  // fallback
  await sendAndSetState({
    tenantId,
    phone,
    body: MSG.MENU,
    state: "MAIN",
    phoneNumberIdFallback: effectivePhoneNumberId,
  });
}

export { handleInbound };
