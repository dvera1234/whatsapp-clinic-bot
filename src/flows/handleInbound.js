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

// 🔥 NOVO: validator
import { validateTenantContent } from "../tenants/validateTenantContent.js";

// 🔥 NEW
import { registerDefaultActions } from "./actions/registerActions.js";

// registra ações uma única vez
registerDefaultActions();

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

  // 🔴 VALIDAÇÃO DO JSON DO TENANT (CRÍTICO)
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
        "⚠️ Ocorreu um erro de configuração. Nossa equipe já foi notificada.",
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

  // 🔥 INATIVIDADE 100% JSON
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

  const raw = normalizeSpaces(inboundText);
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
        body: runtime?.content?.menu?.text,
        state: "MAIN",
        phoneNumberIdFallback: effectivePhoneNumberId,
        resetSession: true,
      });
      return;
    }
  }

  // 🔥 PIPELINE (INALTERADO)
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
    body: runtime?.content?.menu?.text,
    state: "MAIN",
    phoneNumberIdFallback: effectivePhoneNumberId,
  });
}

export { handleInbound };
