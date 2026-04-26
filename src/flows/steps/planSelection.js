import { updateSession } from "../../session/redisSession.js";
import { sendAndSetState } from "../helpers/flowHelpers.js";
import { setStateAndRender } from "../helpers/stateRenderHelpers.js";

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getPlans(runtime) {
  return Array.isArray(runtime?.content?.plans)
    ? runtime.content.plans
    : [];
}

function getFlows(runtime) {
  return isObject(runtime?.content?.flows) ? runtime.content.flows : {};
}

function getPractitioners(runtime) {
  return Array.isArray(runtime?.practitioners) ? runtime.practitioners : [];
}

function findPlanByInput(runtime, raw) {
  const selectedId = String(raw ?? "");
  return getPlans(runtime).find((plan) => String(plan.id) === selectedId) || null;
}

function resolveMessage(runtime, MSG, messageKey) {
  const key = readString(messageKey);
  if (!key) return "";

  return runtime?.content?.messages?.[key] || MSG?.[key] || "";
}

function resolvePlanFlow(runtime, plan) {
  const flowKey = readString(plan?.flow);
  const flows = getFlows(runtime);

  if (!flowKey) {
    throw new Error("TENANT_CONTENT_INVALID:plan_flow_missing");
  }

  const flowConfig =
    isObject(flows?.[flowKey]) ? flows[flowKey] : null;

  if (!flowConfig) {
    throw new Error(`TENANT_CONTENT_INVALID:flow_missing:${flowKey}`);
  }

  const flowType = readString(flowConfig?.type).toUpperCase();

  if (!flowType) {
    throw new Error(`TENANT_CONTENT_INVALID:flow_type_missing:${flowKey}`);
  }

  return {
    key: flowKey,
    type: flowType,
    config: flowConfig,
  };
}

function normalizePractitionerIds(value) {
  if (!Array.isArray(value)) return [];

  return value.map((item) => readString(item)).filter(Boolean);
}

function buildPractitionerIdSet(runtime) {
  const set = new Set();

  for (const practitioner of getPractitioners(runtime)) {
    const practitionerId = readString(practitioner?.practitionerId);
    if (practitionerId) set.add(practitionerId);
  }

  return set;
}

function resolvePractitionerBooking(runtime, plan) {
  const booking = isObject(plan?.booking) ? plan.booking : {};
  const practitionerMode = readString(booking.practitionerMode).toUpperCase();
  const practitionerIds = normalizePractitionerIds(booking.practitionerIds);
  const practitionerIdSet = buildPractitionerIdSet(runtime);

  if (!practitionerMode) {
    return {
      practitionerMode: null,
      practitionerIds: [],
      practitionerId: null,
    };
  }

  if (!["FIXED", "USER_SELECT", "AUTO"].includes(practitionerMode)) {
    throw new Error(
      `TENANT_CONTENT_INVALID:unsupported_practitioner_mode:${practitionerMode}`
    );
  }

  for (const practitionerId of practitionerIds) {
    if (!practitionerIdSet.has(practitionerId)) {
      throw new Error(
        `TENANT_CONTENT_INVALID:plan_booking_practitioner_not_found:${readString(
          plan?.id
        )}:${practitionerId}`
      );
    }
  }

  if (practitionerMode === "FIXED") {
    if (practitionerIds.length !== 1) {
      throw new Error(
        `TENANT_CONTENT_INVALID:fixed_practitioner_mode_requires_exactly_one_practitioner:${readString(
          plan?.id
        )}`
      );
    }

    return {
      practitionerMode,
      practitionerIds,
      practitionerId: practitionerIds[0],
    };
  }

  return {
    practitionerMode,
    practitionerIds,
    practitionerId: null,
  };
}

function buildMenuStateFromTarget(target) {
  const normalized = readString(target);
  if (!normalized) return null;

  if (normalized === "MAIN" || normalized.startsWith("MENU:")) {
    return normalized;
  }

  return `MENU:${normalized}`;
}

function buildStateTarget(target) {
  const normalized = readString(target);
  return normalized || null;
}

function resolveNextStateForBooking(runtime, MSG) {
  const lgpdBody =
    runtime?.content?.messages?.lgpdConsent || MSG?.LGPD_CONSENT || "";

  if (readString(lgpdBody)) {
    return {
      type: "STATE",
      value: "LGPD_CONSENT",
    };
  }

  return {
    type: "CPF",
    value: runtime?.content?.messages?.askCpfPortal || MSG?.ASK_CPF_PORTAL,
  };
}

function applyPlanSession(sessionObj, plan, practitionerBooking) {
  sessionObj.booking = sessionObj.booking || {};

  sessionObj.booking.planId = readString(plan.id);
  sessionObj.booking.planKey = readString(plan.key);
  sessionObj.booking.planFlow = readString(plan.flow);
  sessionObj.booking.planLabel = readString(plan.label);
  sessionObj.booking.planMessageKey = readString(plan.messageKey);
  sessionObj.booking.planNextState = readString(plan.nextState);

  sessionObj.booking.practitionerMode = practitionerBooking.practitionerMode;
  sessionObj.booking.practitionerIds = practitionerBooking.practitionerIds;
  sessionObj.booking.practitionerId = practitionerBooking.practitionerId;

  sessionObj.booking.patientId = null;
  sessionObj.booking.appointmentDate = null;
  sessionObj.booking.selectedDate = null;
  sessionObj.booking.datePage = 0;
  sessionObj.booking.slotPage = 0;
  sessionObj.booking.slots = [];
  sessionObj.booking.selectedSlotId = null;
  sessionObj.booking.isReturn = false;

  sessionObj.pending = null;

  if (sessionObj.portal?.issue) {
    delete sessionObj.portal.issue;
  }
}

async function handleInfoOnlyOrEnd(flowCtx, plan) {
  const { tenantId, phone, phoneNumberId, runtime, MSG, services } = flowCtx;

  const message = resolveMessage(runtime, MSG, plan.messageKey);
  const nextState = buildStateTarget(plan?.nextState);

  if (nextState) {
    await setStateAndRender(
      {
        ...flowCtx,
        state: nextState,
        raw: "",
        upper: "",
        digits: "",
        renderIntroText: message,
      },
      nextState
    );

    return true;
  }

  if (message) {
    await services.sendText({
      tenantId,
      runtime,
      to: phone,
      body: message,
      phoneNumberId,
    });
  }

  return true;
}

async function handleOpenSubmenu(flowCtx, flow) {
  const targetState = buildMenuStateFromTarget(flow?.config?.target);

  if (!targetState) {
    throw new Error(
      `TENANT_CONTENT_INVALID:flow_target_missing:${readString(flow?.key)}`
    );
  }

  await setStateAndRender(flowCtx, targetState);
  return true;
}

async function handleDirectBooking(flowCtx, flow) {
  const targetState = buildStateTarget(
    flow?.config?.target || flow?.config?.targetState
  );

  if (targetState) {
    await setStateAndRender(flowCtx, targetState);
    return true;
  }

  const nextStep = resolveNextStateForBooking(flowCtx.runtime, flowCtx.MSG);

  if (nextStep.type === "STATE") {
    await setStateAndRender(flowCtx, nextStep.value);
    return true;
  }

  await sendAndSetState({
    tenantId: flowCtx.tenantId,
    phone: flowCtx.phone,
    body: nextStep.value,
    state: "WZ_CPF",
    phoneNumberId: flowCtx.phoneNumberId,
  });

  return true;
}

async function handleBookingOrContinue(flowCtx) {
  const nextStep = resolveNextStateForBooking(flowCtx.runtime, flowCtx.MSG);

  if (nextStep.type === "STATE") {
    await setStateAndRender(flowCtx, nextStep.value);
    return true;
  }

  await sendAndSetState({
    tenantId: flowCtx.tenantId,
    phone: flowCtx.phone,
    body: nextStep.value,
    state: "WZ_CPF",
    phoneNumberId: flowCtx.phoneNumberId,
  });

  return true;
}

export async function handlePlanSelectionStep(flowCtx) {
  const { tenantId, runtime, phone, phoneNumberId, raw, state, MSG, services } =
    flowCtx;

  if (state !== "PLAN_PICK") return false;

  if (raw === "BACK_TO_MENU") {
    await setStateAndRender(flowCtx, "MAIN");
    return true;
  }

  const plan = findPlanByInput(runtime, raw);

  if (!plan) {
    await services.sendText({
      tenantId,
      to: phone,
      body:
        runtime?.content?.messages?.pickPlanButtonsOnly ||
        runtime?.content?.messages?.buttonsOnlyWarning ||
        MSG?.PICK_PLAN_BUTTONS_ONLY ||
        MSG?.BUTTONS_ONLY_WARNING,
      phoneNumberId,
    });
    return true;
  }

  const flow = resolvePlanFlow(runtime, plan);
  const practitionerBooking = resolvePractitionerBooking(runtime, plan);

  await updateSession(tenantId, phone, (sessionObj) => {
    applyPlanSession(sessionObj, plan, practitionerBooking);
  });

  if (flow.type === "INFO_ONLY" || flow.type === "END") {
    return await handleInfoOnlyOrEnd(flowCtx, plan);
  }

  if (flow.type === "OPEN_SUBMENU") {
    return await handleOpenSubmenu(flowCtx, flow);
  }

  if (flow.type === "DIRECT_BOOKING") {
    return await handleDirectBooking(flowCtx, flow);
  }

  if (flow.type === "BOOKING" || flow.type === "CONTINUE") {
    const nextState = buildStateTarget(plan?.nextState);
  
    if (nextState) {
      await setStateAndRender(
        {
          ...flowCtx,
          state: nextState,
          raw: "",
          upper: "",
          digits: "",
        },
        nextState
      );
  
      return true;
    }
  
    return await handleBookingOrContinue(flowCtx);
  }

  throw new Error(
    `TENANT_CONTENT_INVALID:unsupported_plan_flow:${readString(plan?.flow)}`
  );
}
