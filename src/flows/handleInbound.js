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

const STEP_REGISTRY = Object.freeze({
  mainMenu: {
    handler: handleMainMenuStep,
    capability: null,
  },
  planSelection: {
    handler: handlePlanSelectionStep,
    capability: null,
  },
  portalFlow: {
    handler: handlePortalFlowStep,
    capability: "access",
  },
  patientIdentification: {
    handler: handlePatientIdentificationStep,
    capability: "identity",
  },
  patientRegistration: {
    handler: handlePatientRegistrationStep,
    capability: "identity",
  },
  slotSelection: {
    handler: handleSlotSelectionStep,
    capability: "booking",
  },
  bookingConfirmation: {
    handler: handleBookingConfirmationStep,
    capability: "booking",
  },
  support: {
    handler: handleSupportFlowStep,
    capability: null,
  },
});

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

function normalizeFlowType(value) {
  return readString(value).toUpperCase();
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
    .filter((item) => isObject(item) && item.active === true)
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

function resolveSelectedPlan({ runtime, session }) {
  const plans = normalizePlans(runtime);
  const booking = isObject(session?.booking) ? session.booking : {};

  const planId = readString(booking.planId);
  const planKey = readString(booking.planKey);

  if (planId) {
    const byId = plans.find((plan) => readString(plan.id) === planId);
    if (byId) return byId;
  }

  if (planKey) {
    const byKey = plans.find((plan) => readString(plan.key) === planKey);
    if (byKey) return byKey;
  }

  return null;
}

function resolvePlanMeta(plan) {
  if (!isObject(plan)) {
    return {
      plan: null,
      rules: {},
      mappings: {},
      planId: null,
      planKey: null,
      planFlow: null,
      planLabel: null,
      planMessageKey: null,
      planNextState: null,
      practitionerMode: null,
      practitionerIds: [],
    };
  }

  return {
    plan,
    rules: isObject(plan.rules) ? plan.rules : {},
    mappings: isObject(plan.mappings) ? plan.mappings : {},
    planId: readString(plan.id) || null,
    planKey: readString(plan.key) || null,
    planFlow: readString(plan.flow) || null,
    planLabel: readString(plan.label) || null,
    planMessageKey: readString(plan.messageKey) || null,
    planNextState: readString(plan.nextState) || null,
    practitionerMode: readString(plan?.booking?.practitionerMode) || null,
    practitionerIds: readStringArray(plan?.booking?.practitionerIds),
  };
}

function resolveAllowedPractitioners({ practitioners, practitionerIds }) {
  if (!Array.isArray(practitioners) || !practitioners.length) return [];

  if (!Array.isArray(practitionerIds) || !practitionerIds.length) {
    return practitioners;
  }

  const allowedSet = new Set(practitionerIds);
  return practitioners.filter((item) => allowedSet.has(item.practitionerId));
}

function resolveSelectedPractitioner({
  session,
  practitionerMode,
  allowedPractitioners,
}) {
  const booking = isObject(session?.booking) ? session.booking : {};
  const sessionPractitionerId = readString(booking.practitionerId);

  if (sessionPractitionerId) {
    const bySession = allowedPractitioners.find(
      (item) => item.practitionerId === sessionPractitionerId
    );
    if (bySession) return bySession;
  }

  if (practitionerMode === "FIXED" && allowedPractitioners.length === 1) {
    return allowedPractitioners[0];
  }

  if (practitionerMode === "USER_SELECT") {
    return null;
  }

  if (practitionerMode === "AUTO") {
    return null;
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

function resolveFlowType(runtime, planFlow) {
  const flowMap = isObject(runtime?.content?.flows) ? runtime.content.flows : {};

  if (!planFlow) {
    return "";
  }

  const flowConfig = isObject(flowMap[planFlow]) ? flowMap[planFlow] : null;
  return normalizeFlowType(flowConfig?.type);
}

function normalizeDispatch(runtime) {
  const source = isObject(runtime?.content?.dispatch)
    ? runtime.content.dispatch
    : {};

  return {
    stateHandlers: isObject(source.stateHandlers) ? source.stateHandlers : {},
    statePrefixes: isObject(source.statePrefixes) ? source.statePrefixes : {},
    flowTypeHandlers: isObject(source.flowTypeHandlers)
      ? source.flowTypeHandlers
      : {},
    defaultHandler: readString(source.defaultHandler),
  };
}

function resolveHandlerNameFromState(dispatch, state) {
  const normalizedState = readString(state);
  if (!normalizedState) return "";

  const exact = readString(dispatch.stateHandlers?.[normalizedState]);
  if (exact) return exact;

  const prefixEntries = Object.entries(dispatch.statePrefixes || {}).sort(
    (a, b) => String(b[0]).length - String(a[0]).length
  );

  for (const [prefix, handlerName] of prefixEntries) {
    const safePrefix = readString(prefix);
    const safeHandlerName = readString(handlerName);

    if (!safePrefix || !safeHandlerName) continue;
    if (normalizedState.startsWith(safePrefix)) return safeHandlerName;
  }

  return "";
}

function resolveHandlerNameFromFlowType(dispatch, flowType) {
  return readString(dispatch.flowTypeHandlers?.[normalizeFlowType(flowType)]);
}

function resolveStepDefinition(flowCtx) {
  const dispatch = normalizeDispatch(flowCtx.runtime);

  const handlerName =
    resolveHandlerNameFromState(dispatch, flowCtx.state) ||
    resolveHandlerNameFromFlowType(dispatch, flowCtx.flowType) ||
    dispatch.defaultHandler;

  if (!handlerName) {
    return null;
  }

  const stepDefinition = STEP_REGISTRY[handlerName];
  if (!stepDefinition) {
    errLog("FLOW_HANDLER_NOT_REGISTERED", {
      tenantId: flowCtx.tenantId,
      traceId: flowCtx.traceId,
      handlerName,
      state: flowCtx.state,
      flowType: flowCtx.flowType,
    });
    return null;
  }

  if (
    stepDefinition.capability &&
    !flowCtx.capabilities?.[stepDefinition.capability]
  ) {
    audit("FLOW_HANDLER_CAPABILITY_UNAVAILABLE", {
      tenantId: flowCtx.tenantId,
      traceId: flowCtx.traceId,
      handlerName,
      capability: stepDefinition.capability,
      state: flowCtx.state,
      flowType: flowCtx.flowType,
    });
    return null;
  }

  return stepDefinition;
}

async function runFlow(flowCtx) {
  const stepDefinition = resolveStepDefinition(flowCtx);

  if (!stepDefinition || typeof stepDefinition.handler !== "function") {
    return false;
  }

  return stepDefinition.handler(flowCtx);
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
      runtime,
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
    sendText: ({ tenantId, to, body, phoneNumberId }) =>
      sendText({
        tenantId,
        runtime,
        to,
        body,
        phoneNumberId,
      }),
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
  const session = await getSession(tenantId, phone);

  const plan = resolveSelectedPlan({
    runtime,
    session,
  });

  const planMeta = resolvePlanMeta(plan);
  const flowType = resolveFlowType(runtime, planMeta.planFlow);

  const practitioners = normalizePractitioners(runtime);
  const allowedPractitioners = resolveAllowedPractitioners({
    practitioners,
    practitionerIds: planMeta.practitionerIds,
  });

  const selectedPractitioner = resolveSelectedPractitioner({
    session,
    practitionerMode: planMeta.practitionerMode,
    allowedPractitioners,
  });

  const runtimeCtx = {
    tenantId,
    runtime,
    traceId,
    tracePhone: maskPhone(phone),
  };

  const services = {
    sendText: ({ tenantId, to, body, phoneNumberId }) =>
      sendText({
        tenantId,
        runtime,
        to,
        body,
        phoneNumberId,
      }),

    sendButtons: ({ tenantId, to, body, buttons, phoneNumberId }) =>
      sendButtons({
        tenantId,
        runtime,
        to,
        body,
        buttons,
        phoneNumberId,
      }),

    sendList: ({
      tenantId,
      to,
      body,
      buttonText,
      sections,
      footerText,
      headerText,
      phoneNumberId,
    }) =>
      sendList({
        tenantId,
        runtime,
        to,
        body,
        buttonText,
        sections,
        footerText,
        headerText,
        phoneNumberId,
      }),
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

    session,
    booking: isObject(session?.booking) ? session.booking : null,
    portal: isObject(session?.portal) ? session.portal : null,
    pending: isObject(session?.pending) ? session.pending : null,

    plan: planMeta.plan,
    rules: planMeta.rules,
    mappings: planMeta.mappings,

    planId: planMeta.planId,
    planKey: planMeta.planKey,
    planFlow: planMeta.planFlow,
    planLabel: planMeta.planLabel,
    planMessageKey: planMeta.planMessageKey,
    planNextState: planMeta.planNextState,

    practitionerMode: planMeta.practitionerMode,
    flowType,

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
      rules: {},
      mappings: {},
      planId: null,
      planKey: null,
      planFlow: null,
      planLabel: null,
      planMessageKey: null,
      planNextState: null,
      practitionerMode: null,
      flowType: "",
      allowedPractitioners: practitioners,
      selectedPractitioner: null,
      selectedPractitionerId: null,
    });

    return;
  }

  const consumed = await runFlow(flowCtx);
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
