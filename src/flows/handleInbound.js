import crypto from "crypto";

import {
  configureInactivityHandler,
  touchUser,
  getState,
  clearSession,
  setState,
} from "../session/redisSession.js";

import { sendText, sendButtons, sendList } from "../whatsapp/sender.js";

import { FLOW_RESET_CODE } from "../config/constants.js";

import { createPatientAdapter } from "../integrations/adapters/factories/createPatientAdapter.js";
import { createPortalAdapter } from "../integrations/adapters/factories/createPortalAdapter.js";
import { createSchedulingAdapter } from "../integrations/adapters/factories/createSchedulingAdapter.js";

import { onlyDigits, normalizeSpaces } from "../utils/validators.js";
import { audit, errLog } from "../observability/audit.js";
import { maskPhone } from "../utils/mask.js";

import { handleMainMenuStep } from "./steps/mainMenu.js";
import { handlePlanSelectionStep } from "./steps/planSelection.js";
import { handlePatientIdentificationStep } from "./steps/patientIdentification.js";
import { handlePatientRegistrationStep } from "./steps/patientRegistration.js";
import { handleSlotSelectionStep } from "./steps/slotSelection.js";
import { handleBookingConfirmationStep } from "./steps/bookingConfirmation.js";
import { handlePortalFlowStep } from "./steps/portalFlow.js";
import { handleSupportFlowStep } from "./steps/supportFlow.js";

import {
  resolveRuntimeFromContext,
  failSafeTenantConfigError,
} from "./helpers/flowHelpers.js";

import { renderState } from "./helpers/stateRenderHelpers.js";
import { getFlowText } from "./helpers/contentHelpers.js";

import { validateTenantContent } from "../tenants/validateTenantContent.js";

import { registerDefaultActions } from "./actions/registerActions.js";

registerDefaultActions();

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveEffectivePhoneNumberId(context = {}, phoneNumberId) {
  const fromContext = readString(context?.phoneNumberId);
  if (fromContext) return fromContext;

  const fromParam = readString(phoneNumberId);
  if (fromParam) return fromParam;

  return "";
}

async function handleInbound({
  context = {},
  phone,
  text: inboundText,
  message,
  phoneNumberId,
}) {
  const traceId = readString(context?.traceId) || crypto.randomUUID();
  const tenantId = readString(context?.tenantId);
  const effectivePhoneNumberId = resolveEffectivePhoneNumberId(
    context,
    phoneNumberId
  );

  if (!tenantId) {
    audit("TENANT_CONTEXT_MISSING", {
      traceId,
      tracePhone: maskPhone(phone),
    });
    return;
  }

  if (!effectivePhoneNumberId) {
    errLog("PHONE_NUMBER_ID_MISSING", {
      tenantId,
      traceId,
      hasContextPhoneNumberId: !!readString(context?.phoneNumberId),
      hasParamPhoneNumberId: !!readString(phoneNumberId),
    });
    return;
  }

  const runtime = resolveRuntimeFromContext(context);

  if (!runtime) {
    await failSafeTenantConfigError({
      tenantId,
      phone,
      phoneNumberId: effectivePhoneNumberId,
    });
    return;
  }

  const validation = validateTenantContent(runtime.content, {
    practitioners: runtime.practitioners,
  });

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
      phoneNumberId: effectivePhoneNumberId,
    });

    return;
  }

  let MSG;
  try {
    MSG = getFlowText(runtime);
  } catch (error) {
    errLog("FLOW_TEXT_BUILD_FAILED", {
      tenantId,
      traceId,
      error: String(error?.message || error),
    });

    await failSafeTenantConfigError({
      tenantId,
      phone,
      phoneNumberId: effectivePhoneNumberId,
    });
    return;
  }

  configureInactivityHandler({
    sendText,
    getMessage: () =>
      runtime?.content?.messages?.inactivityClosedMessage ||
      "Sessão encerrada por inatividade.",
  });

  let patientAdapter;
  let portalAdapter;
  let schedulingAdapter;

  try {
    patientAdapter = createPatientAdapter({ tenantId, runtime });
    portalAdapter = createPortalAdapter({ tenantId, runtime });
    schedulingAdapter = createSchedulingAdapter({ tenantId, runtime });
  } catch (error) {
    errLog("FLOW_ADAPTER_INIT_FAILED", {
      tenantId,
      traceId,
      error: String(error?.message || error),
    });

    await failSafeTenantConfigError({
      tenantId,
      phone,
      phoneNumberId: effectivePhoneNumberId,
    });
    return;
  }

  const listReplyId = message?.interactive?.list_reply?.id || null;
  const buttonReplyId = message?.interactive?.button_reply?.id || null;

  const rawInput = listReplyId || buttonReplyId || inboundText || "";
  const raw = normalizeSpaces(rawInput);
  const digits = onlyDigits(raw);
  const upper = String(raw || "").toUpperCase();

  await touchUser({
    tenantId,
    phone,
    phoneNumberId: effectivePhoneNumberId,
  });

  const state = (await getState(tenantId, phone)) || "MAIN";

  const runtimeCtx = {
    tenantId,
    runtime,
    traceId,
    tracePhone: maskPhone(phone),
  };

  const adapters = {
    patientAdapter,
    portalAdapter,
    schedulingAdapter,
  };

  const services = {
    sendText,
    sendButtons,
    sendList,
  };

  const flowCtx = {
    context,
    tenantId,
    runtime,
    runtimeCtx,
    traceId,
    phone,
    phoneNumberId: effectivePhoneNumberId,
    raw,
    upper,
    digits,
    state,
    MSG,
    practitioners: Array.isArray(runtime?.practitioners)
      ? runtime.practitioners
      : [],
    adapters,
    services,
  };

  {
    const resetCode = readString(FLOW_RESET_CODE);

    if (resetCode && upper === resetCode.toUpperCase()) {
      await clearSession(tenantId, phone);
      await setState(tenantId, phone, "MAIN");

      await renderState({
        ...flowCtx,
        raw: "",
        upper: "",
        digits: "",
        state: "MAIN",
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
  if (await handleSupportFlowStep(flowCtx)) return;

  await setState(tenantId, phone, "MAIN");

  await renderState({
    ...flowCtx,
    raw: "",
    upper: "",
    digits: "",
    state: "MAIN",
  });
}

export { handleInbound };
