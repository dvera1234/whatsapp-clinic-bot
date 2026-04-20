import crypto from "crypto";

import {
  configureInactivityHandler,
  touchUser,
  getState,
  getSession,
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

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readStringArray(value) {
  if (!Array.isArray(value)) return [];

  return value.map((item) => readString(item)).filter(Boolean);
}

function resolveEffectivePhoneNumberId(context = {}, phoneNumberId) {
  const fromContext = readString(context?.phoneNumberId);
  if (fromContext) return fromContext;

  const fromParam = readString(phoneNumberId);
  if (fromParam) return fromParam;

  return "";
}

function normalizePractitioners(runtime) {
  if (!Array.isArray(runtime?.practitioners)) return [];

  return runtime.practitioners
    .filter((item) => isObject(item))
    .map((item) => ({
      practitionerId: readString(item.practitionerId),
      practitionerKey: readString(item.practitionerKey),
      label: readString(item.label),
      externalId: item.externalId ?? null,
      specialtyId: item.specialtyId ?? null,
      active: item.active === true,
      sortOrder: item.sortOrder ?? null,
    }))
    .filter((item) => item.practitionerId);
}

function normalizePlans(runtime) {
  if (!Array.isArray(runtime?.content?.plans)) return [];
  return runtime.content.plans.filter((item) => isObject(item));
}

function resolveSelectedPlan({ runtime, sessionObj }) {
  const plans = normalizePlans(runtime);
  const booking = isObject(sessionObj?.booking) ? sessionObj.booking : {};

  const sessionPlanId = readString(booking.planId);
  const sessionPlanKey = readString(booking.planKey);

  if (sessionPlanId) {
    const byId = plans.find((plan) => readString(plan.id) === sessionPlanId);
    if (byId) return byId;
  }

  if (sessionPlanKey) {
    const byKey = plans.find((plan) => readString(plan.key) === sessionPlanKey);
    if (byKey) return byKey;
  }

  return null;
}

function resolveSelectedPlanMeta(selectedPlan) {
  if (!isObject(selectedPlan)) {
    return {
      plan: null,
      rules: {},
      booking: {},
      mappings: {},
      planId: null,
      planKey: null,
      planFlow: null,
      planLabel: null,
      planMessageKey: null,
      planNextState: null,
    };
  }

  return {
    plan: selectedPlan,
    rules: isObject(selectedPlan.rules) ? selectedPlan.rules : {},
    booking: isObject(selectedPlan.booking) ? selectedPlan.booking : {},
    mappings: isObject(selectedPlan.mappings) ? selectedPlan.mappings : {},
    planId: readString(selectedPlan.id) || null,
    planKey: readString(selectedPlan.key) || null,
    planFlow: readString(selectedPlan.flow) || null,
    planLabel: readString(selectedPlan.label) || null,
    planMessageKey: readString(selectedPlan.messageKey) || null,
    planNextState: readString(selectedPlan.nextState) || null,
  };
}

function resolveAllowedPractitioners({ runtime, selectedPlan }) {
  const practitioners = normalizePractitioners(runtime);
  if (!practitioners.length) return [];

  const booking = isObject(selectedPlan?.booking) ? selectedPlan.booking : {};
  const practitionerIds = readStringArray(booking.practitionerIds);

  if (!practitionerIds.length) {
    return practitioners;
  }

  const allowedSet = new Set(practitionerIds);
  return practitioners.filter((item) => allowedSet.has(item.practitionerId));
}

function resolveSelectedPractitioner({
  sessionObj,
  planBooking,
  allowedPractitioners,
}) {
  const booking = isObject(sessionObj?.booking) ? sessionObj.booking : {};
  const sessionPractitionerId = readString(booking.practitionerId);

  if (sessionPractitionerId) {
    const bySession = allowedPractitioners.find(
      (item) => item.practitionerId === sessionPractitionerId
    );
    if (bySession) return bySession;
  }

  const practitionerMode = readString(planBooking?.practitionerMode);

  if (practitionerMode === "FIXED" && allowedPractitioners.length === 1) {
    return allowedPractitioners[0];
  }

  if (practitionerMode === "AUTO" && allowedPractitioners.length === 1) {
    return allowedPractitioners[0];
  }

  return null;
}

function resolveResetCode(runtime) {
  const fromContent = readString(runtime?.content?.flowResetCode);
  if (fromContent) return fromContent;
  return readString(FLOW_RESET_CODE);
}

function buildAdapters({ tenantId, runtime }) {
  const providers = isObject(runtime?.providers) ? runtime.providers : {};

  return {
    patientAdapter: providers.identity
      ? createPatientAdapter({ tenantId, runtime })
      : null,

    portalAdapter: providers.access
      ? createPortalAdapter({ tenantId, runtime })
      : null,

    schedulingAdapter: providers.booking
      ? createSchedulingAdapter({ tenantId, runtime })
      : null,
  };
}

function normalizeFlowType(flowType) {
  return readString(flowType).toUpperCase();
}

function resolveSelectedPlanFlowConfig(runtime, selectedPlanMeta) {
  const flowKey = readString(selectedPlanMeta.planFlow);
  const flowMap = isObject(runtime?.content?.flows) ? runtime.content.flows : {};

  if (!flowKey) {
    return {
      key: null,
      type: "",
      config: null,
    };
  }

  const flowConfig = isObject(flowMap[flowKey]) ? flowMap[flowKey] : null;

  return {
    key: flowKey || null,
    type: normalizeFlowType(flowConfig?.type),
    config: flowConfig,
  };
}

function isMainLikeState(state) {
  return (
    state === "MAIN" ||
    state === "MENU" ||
    state.startsWith("MENU:") ||
    state.startsWith("POS_")
  );
}

function isPlanSelectionLikeState(state) {
  return state === "PLAN_PICK" || state === "LGPD_CONSENT";
}

function isPortalLikeState(state) {
  return state.startsWith("PORTAL_") || state.startsWith("PWD_");
}

function isPatientIdentificationLikeState(state) {
  return state === "ASK_CPF" || state === "WZ_CPF";
}

function isPatientRegistrationLikeState(state) {
  return state.startsWith("WZ_") && state !== "WZ_CPF";
}

function isSlotSelectionLikeState(state) {
  return (
    state === "DATES" ||
    state === "SLOTS" ||
    state.includes("DATE") ||
    state.includes("SLOT")
  );
}

function isBookingConfirmationLikeState(state) {
  return state.includes("CONFIRM");
}

function isSupportLikeState(state) {
  return state === "ATENDENTE" || state.startsWith("SUPPORT_");
}

function buildStepDefinitions(flowCtx) {
  const selectedPlanFlowType = flowCtx.selectedPlanFlowType;
  const capabilities = flowCtx.capabilities;

  return [
    {
      name: "mainMenu",
      handler: handleMainMenuStep,
      enabled: true,
      priority: isMainLikeState(flowCtx.state) ? 10 : 100,
    },
    {
      name: "planSelection",
      handler: handlePlanSelectionStep,
      enabled: true,
      priority:
        isPlanSelectionLikeState(flowCtx.state) ||
        !flowCtx.selectedPlanId ||
        selectedPlanFlowType === "OPEN_SUBMENU" ||
        selectedPlanFlowType === "DIRECT_BOOKING" ||
        selectedPlanFlowType === "BOOKING" ||
        selectedPlanFlowType === "CONTINUE" ||
        selectedPlanFlowType === "INFO_ONLY" ||
        selectedPlanFlowType === "END"
          ? 20
          : 120,
    },
    {
      name: "portalFlow",
      handler: handlePortalFlowStep,
      enabled: capabilities.access,
      priority: isPortalLikeState(flowCtx.state) ? 30 : 130,
    },
    {
      name: "patientIdentification",
      handler: handlePatientIdentificationStep,
      enabled: capabilities.identity,
      priority:
        isPatientIdentificationLikeState(flowCtx.state) ||
        (selectedPlanFlowType === "BOOKING" && flowCtx.state === "ASK_CPF") ||
        (selectedPlanFlowType === "CONTINUE" && flowCtx.state === "ASK_CPF")
          ? 40
          : 140,
    },
    {
      name: "patientRegistration",
      handler: handlePatientRegistrationStep,
      enabled: capabilities.identity,
      priority: isPatientRegistrationLikeState(flowCtx.state) ? 50 : 150,
    },
    {
      name: "slotSelection",
      handler: handleSlotSelectionStep,
      enabled: capabilities.booking,
      priority:
        isSlotSelectionLikeState(flowCtx.state) ||
        selectedPlanFlowType === "BOOKING" ||
        selectedPlanFlowType === "DIRECT_BOOKING"
          ? 60
          : 160,
    },
    {
      name: "bookingConfirmation",
      handler: handleBookingConfirmationStep,
      enabled: capabilities.booking,
      priority:
        isBookingConfirmationLikeState(flowCtx.state) ||
        selectedPlanFlowType === "BOOKING"
          ? 70
          : 170,
    },
    {
      name: "support",
      handler: handleSupportFlowStep,
      enabled: true,
      priority: isSupportLikeState(flowCtx.state) ? 80 : 180,
    },
  ]
    .filter((item) => item.enabled)
    .sort((a, b) => a.priority - b.priority);
}

async function runStepPipeline(flowCtx) {
  const stepDefinitions = buildStepDefinitions(flowCtx);

  for (const stepDefinition of stepDefinitions) {
    if (typeof stepDefinition?.handler !== "function") continue;
    if (await stepDefinition.handler(flowCtx)) return true;
  }

  return false;
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

  let adapters;
  try {
    adapters = buildAdapters({ tenantId, runtime });
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

  const listReplyId = readString(message?.interactive?.list_reply?.id);
  const buttonReplyId = readString(message?.interactive?.button_reply?.id);
  const rawInput = listReplyId || buttonReplyId || readString(inboundText);
  const raw = normalizeSpaces(rawInput);
  const digits = onlyDigits(raw);
  const upper = String(raw || "").toUpperCase();

  await touchUser({
    tenantId,
    phone,
    phoneNumberId: effectivePhoneNumberId,
  });

  const state = (await getState(tenantId, phone)) || "MAIN";
  const sessionObj = await getSession(tenantId, phone);

  const selectedPlan = resolveSelectedPlan({
    runtime,
    sessionObj,
  });

  const selectedPlanMeta = resolveSelectedPlanMeta(selectedPlan);
  const selectedPlanFlow = resolveSelectedPlanFlowConfig(runtime, selectedPlanMeta);

  const practitioners = normalizePractitioners(runtime);
  const allowedPractitioners = resolveAllowedPractitioners({
    runtime,
    selectedPlan,
  });
  const selectedPractitioner = resolveSelectedPractitioner({
    sessionObj,
    planBooking: selectedPlanMeta.booking,
    allowedPractitioners,
  });

  const runtimeCtx = {
    tenantId,
    runtime,
    traceId,
    tracePhone: maskPhone(phone),
  };

  const services = {
    sendText,
    sendButtons,
    sendList,
  };

  const capabilities = {
    identity: !!adapters.patientAdapter,
    access: !!adapters.portalAdapter,
    booking: !!adapters.schedulingAdapter,
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

    session: sessionObj,
    booking: isObject(sessionObj?.booking) ? sessionObj.booking : null,
    portal: isObject(sessionObj?.portal) ? sessionObj.portal : null,
    pending: isObject(sessionObj?.pending) ? sessionObj.pending : null,

    plan: selectedPlanMeta.plan,
    planRules: selectedPlanMeta.rules,
    planBooking: selectedPlanMeta.booking,
    planMappings: selectedPlanMeta.mappings,

    selectedPlanId: selectedPlanMeta.planId,
    selectedPlanKey: selectedPlanMeta.planKey,
    selectedPlanFlow: selectedPlanMeta.planFlow,
    selectedPlanLabel: selectedPlanMeta.planLabel,
    selectedPlanMessageKey: selectedPlanMeta.planMessageKey,
    selectedPlanNextState: selectedPlanMeta.planNextState,

    selectedPlanFlowType: selectedPlanFlow.type,
    selectedPlanFlowConfig: selectedPlanFlow.config,

    practitioners,
    allowedPractitioners,
    selectedPractitioner,
    selectedPractitionerId: selectedPractitioner?.practitionerId || null,

    adapters,
    services,
    capabilities,
  };

  const resetCode = resolveResetCode(runtime);
  if (resetCode && upper === resetCode.toUpperCase()) {
    await clearSession(tenantId, phone);
    await setState(tenantId, phone, "MAIN");

    await renderState({
      ...flowCtx,
      raw: "",
      upper: "",
      digits: "",
      state: "MAIN",
      session: null,
      booking: null,
      portal: null,
      pending: null,
      plan: null,
      planRules: {},
      planBooking: {},
      planMappings: {},
      selectedPlanId: null,
      selectedPlanKey: null,
      selectedPlanFlow: null,
      selectedPlanLabel: null,
      selectedPlanMessageKey: null,
      selectedPlanNextState: null,
      selectedPlanFlowType: "",
      selectedPlanFlowConfig: null,
      allowedPractitioners: practitioners,
      selectedPractitioner: null,
      selectedPractitionerId: null,
    });

    return;
  }

  const consumed = await runStepPipeline(flowCtx);
  if (consumed) return;

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
