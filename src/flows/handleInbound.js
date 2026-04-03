import crypto from "crypto";

import {
  configureInactivityHandler,
  touchUser,
  getState,
} from "../session/redisSession.js";

import { sendText, sendButtons, sendList } from "../whatsapp/sender.js";

import { FLOW_RESET_CODE } from "../config/constants.js";

import { createPatientAdapter } from "../integrations/adapters/factories/createPatientAdapter.js";
import { createPortalAdapter } from "../integrations/adapters/factories/createPortalAdapter.js";
import { createSchedulingAdapter } from "../integrations/adapters/factories/createSchedulingAdapter.js";

import { onlyDigits, normalizeSpaces } from "../utils/validators.js";
import { audit } from "../observability/audit.js";
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

import { validateTenantContent } from "../tenants/validateTenantContent.js";

import { registerDefaultActions } from "./actions/registerActions.js";

registerDefaultActions();

async function handleInbound({
  context = {},
  phone,
  text: inboundText,
  message,
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

  const validation = validateTenantContent(runtime.content);

  if (!validation.ok) {
    audit("TENANT_CONTENT_INVALID", {
      tenantId,
      traceId,
      errors: validation.errors,
    });

    await sendText({
      tenantId,
      to: phone,
      body:
        "⚠️ Ocorreu um erro de configuração temporário. Por favor, fale com nossa equipe.",
      phoneNumberIdFallback: effectivePhoneNumberId,
    });

    return;
  }

  let MSG;
  try {
    MSG = getFlowText(runtime);
  } catch {
    await failSafeTenantConfigError({
      tenantId,
      phone,
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
    return;
  }

  configureInactivityHandler({
    sendText,
    getMessage: () => runtime.content.messages.inactivityClosedMessage,
  });

  let patientAdapter;
  let portalAdapter;
  let schedulingAdapter;

  try {
    patientAdapter = createPatientAdapter({ tenantId, runtime });
    portalAdapter = createPortalAdapter({ tenantId, runtime });
    schedulingAdapter = createSchedulingAdapter({ tenantId, runtime });
  } catch {
    await failSafeTenantConfigError({
      tenantId,
      phone,
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
    return;
  }

  const practitionerId = runtime?.clinic?.providerId ?? null;

  const listReplyId = message?.interactive?.list_reply?.id || null;
  const buttonReplyId = message?.interactive?.button_reply?.id || null;

  const rawInput = listReplyId || buttonReplyId || inboundText || "";
  const raw = normalizeSpaces(rawInput);
  const digits = onlyDigits(raw);
  const upper = String(raw || "").toUpperCase();

  await touchUser({
    tenantId,
    phone,
    phoneNumberIdFallback: effectivePhoneNumberId,
  });

  const state = (await getState(tenantId, phone)) || "MAIN";

  const runtimeCtx = {
    tenantId,
    runtime,
    traceId,
    tracePhone: maskPhone(phone),
  };

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
    adapters: {
      patientAdapter,
      portalAdapter,
      schedulingAdapter,
    },
    services: {
      sendText,
      sendButtons,
      sendList,
    },
  };

  {
    const code = String(FLOW_RESET_CODE || "").trim();

    if (code && raw.toUpperCase() === code.toUpperCase()) {
      await sendAndSetState({
        tenantId,
        phone,
        body: runtime?.content?.menu?.text,
        state: "MAIN",
        phoneNumberIdFallback: effectivePhoneNumberId,
        resetSession: true,
      });
      return;
    }
  }

  if (await handleMainMenuStep(flowCtx)) return;
  if (await handlePlanSelectionStep(flowCtx)) return;
  if (await handlePortalFlowStep(flowCtx)) return;
  if (await handlePatientIdentificationStep(flowCtx)) return;
  if (await handlePatientRegistrationStep(flowCtx)) return;
  if (await handleSlotSelectionStep(flowCtx)) return;
  if (await handleBookingConfirmationStep(flowCtx)) return;
  if (await handlePostFlowStep(flowCtx)) return;
  if (await handleSupportFlowStep(flowCtx)) return;

  await sendAndSetState({
    tenantId,
    phone,
    body: runtime?.content?.menu?.text,
    state: "MAIN",
    phoneNumberIdFallback: effectivePhoneNumberId,
  });
}

export { handleInbound };
