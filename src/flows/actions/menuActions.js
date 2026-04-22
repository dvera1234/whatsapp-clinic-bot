import { setState } from "../../session/redisSession.js";
import { sendListMessage } from "../../whatsapp/sendListMessage.js";
import { resetToMain, sendAndSetState } from "../helpers/flowHelpers.js";
import { renderState } from "../helpers/stateRenderHelpers.js";
import { audit } from "../../observability/audit.js";

const PRACTITIONER_MODES = new Set(["FIXED", "USER_SELECT", "AUTO"]);

// =========================
// HELPERS
// =========================

function getMessages(runtime) {
  return runtime?.content?.messages || {};
}

function getDispatch(runtime) {
  return runtime?.content?.dispatch || {};
}

function getSubmenus(runtime) {
  return runtime?.content?.submenus || {};
}

function getSubmenu(runtime, key) {
  return getSubmenus(runtime)?.[key] || null;
}

function getPlans(runtime) {
  return Array.isArray(runtime?.content?.plans) ? runtime.content.plans : [];
}

function getPractitioners(runtime) {
  return Array.isArray(runtime?.practitioners) ? runtime.practitioners : [];
}

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function ensureRequiredString(value, errorCode) {
  const normalized = readString(value);
  if (!normalized) {
    throw new Error(errorCode);
  }
  return normalized;
}

function ensureOptions(menuLike, fieldName) {
  const options = Array.isArray(menuLike?.options) ? menuLike.options : [];
  if (!options.length) {
    throw new Error(`TENANT_CONTENT_INVALID:${fieldName}.options_empty`);
  }
  return options;
}

function buildSectionsFromOptions(menuLike, fieldName) {
  const options = ensureOptions(menuLike, fieldName);

  return [
    {
      title: readString(menuLike?.sectionTitle),
      rows: options.map((opt) => ({
        id: String(opt.id),
        title: String(opt.label || opt.id),
        description: readString(opt.description),
      })),
    },
  ];
}

function buildPlanSections(plans, sectionTitle) {
  return [
    {
      title: readString(sectionTitle),
      rows: plans.map((plan) => ({
        id: String(plan.id),
        title: String(plan.label || plan.id),
        description: readString(plan.description),
      })),
    },
  ];
}

function getMenuStateKey(submenuKey) {
  return `MENU:${String(submenuKey || "").trim()}`;
}

function resolveMessageBody(runtime, explicitMessageKey, fallbackMessageKey) {
  const messages = getMessages(runtime);

  const messageKey = readString(explicitMessageKey) || readString(fallbackMessageKey);
  if (!messageKey) {
    return "";
  }

  return readString(messages?.[messageKey]);
}

function resolvePlanMenuState(menuOption) {
  return ensureRequiredString(
    menuOption?.targetState,
    "TENANT_CONTENT_INVALID:targetState_missing"
  );
}

function findPlanById(runtime, planId) {
  return getPlans(runtime).find((plan) => String(plan?.id) === String(planId));
}

function findPlanByKey(runtime, planKey) {
  return getPlans(runtime).find(
    (plan) => readString(plan?.key) === readString(planKey)
  );
}

function assertKnownState(runtime, targetState) {
  const normalizedTargetState = readString(targetState);
  const dispatch = getDispatch(runtime);

  const stateHandlers =
    dispatch && typeof dispatch.stateHandlers === "object"
      ? dispatch.stateHandlers
      : {};

  const statePrefixes =
    dispatch && typeof dispatch.statePrefixes === "object"
      ? dispatch.statePrefixes
      : {};

  if (stateHandlers[normalizedTargetState]) {
    return normalizedTargetState;
  }

  const matchedPrefix = Object.keys(statePrefixes).find(
    (prefix) =>
      normalizedTargetState === prefix ||
      normalizedTargetState.startsWith(`${prefix}:`)
  );

  if (matchedPrefix) {
    return normalizedTargetState;
  }

  if (normalizedTargetState === "MAIN") {
    return normalizedTargetState;
  }

  throw new Error(`TENANT_CONTENT_INVALID:unknown_target_state:${normalizedTargetState}`);
}

function assertValidPractitionerMode(mode) {
  const normalizedMode = readString(mode);

  if (!normalizedMode) {
    throw new Error("TENANT_CONTENT_INVALID:plans[].booking.practitionerMode_missing");
  }

  if (!PRACTITIONER_MODES.has(normalizedMode)) {
    throw new Error(
      `TENANT_CONTENT_INVALID:invalid_practitioner_mode:${normalizedMode}`
    );
  }

  return normalizedMode;
}

function assertValidPractitionerIds(practitionerIds, runtime) {
  if (practitionerIds == null) {
    return [];
  }

  if (!Array.isArray(practitionerIds)) {
    throw new Error("TENANT_CONTENT_INVALID:plans[].booking.practitionerIds_invalid");
  }

  const normalizedIds = practitionerIds
    .map((value) => readString(value))
    .filter(Boolean);

  const practitioners = getPractitioners(runtime);
  const practitionerIdSet = new Set(
    practitioners.map((item) => readString(item?.practitionerId)).filter(Boolean)
  );

  if (practitionerIdSet.size) {
    for (const practitionerId of normalizedIds) {
      if (!practitionerIdSet.has(practitionerId)) {
        throw new Error(
          `TENANT_CONTENT_INVALID:unknown_practitionerId:${practitionerId}`
        );
      }
    }
  }

  return normalizedIds;
}

function assertPlanIsActionReady(plan, runtime) {
  if (!plan || typeof plan !== "object") {
    throw new Error("TENANT_CONTENT_INVALID:plan_not_found");
  }

  const planId = readString(plan.id);
  const planKey = readString(plan.key);

  if (!planId) {
    throw new Error("TENANT_CONTENT_INVALID:plans[].id_missing");
  }

  if (!planKey) {
    throw new Error("TENANT_CONTENT_INVALID:plans[].key_missing");
  }

  const booking = plan?.booking;
  if (!booking || typeof booking !== "object") {
    return plan;
  }

  assertValidPractitionerMode(booking.practitionerMode);
  assertValidPractitionerIds(booking.practitionerIds, runtime);

  return plan;
}

function buildPlanSelectionFlowCtx(flowCtx, planId, targetState) {
  return {
    ...flowCtx,
    state: targetState,
    raw: String(planId),
    upper: String(planId).toUpperCase(),
    digits: "",
  };
}

// =========================
// ACTIONS
// =========================

export async function actionOpenSubmenu(flowCtx) {
  const { tenantId, runtime, phone, phoneNumberId, menuOption } = flowCtx;

  const submenuKey = ensureRequiredString(
    menuOption?.target,
    "TENANT_CONTENT_INVALID:submenu_target_missing"
  );

  const submenu = getSubmenu(runtime, submenuKey);
  if (!submenu) {
    throw new Error(`TENANT_CONTENT_INVALID:submenu_missing:${submenuKey}`);
  }

  const body = ensureRequiredString(
    submenu?.text,
    `TENANT_CONTENT_INVALID:submenus.${submenuKey}.text_missing`
  );

  const buttonText = ensureRequiredString(
    submenu?.buttonText || getMessages(runtime)?.listButtonText,
    `TENANT_CONTENT_INVALID:submenus.${submenuKey}.buttonText_missing`
  );

  await sendListMessage({
    tenantId,
    runtime,
    to: phone,
    phoneNumberId,
    body,
    buttonText,
    sections: buildSectionsFromOptions(submenu, `submenus.${submenuKey}`),
  });

  await setState(tenantId, phone, getMenuStateKey(submenuKey));
  return true;
}

export async function actionGoMain(flowCtx) {
  return await resetToMain(flowCtx);
}

export async function actionPlanMenu(flowCtx) {
  const { tenantId, runtime, phone, phoneNumberId, menuOption } = flowCtx;

  const targetState = assertKnownState(runtime, resolvePlanMenuState(menuOption));

  const plans = getPlans(runtime)
    .filter((plan) => plan?.active !== false)
    .map((plan) => assertPlanIsActionReady(plan, runtime));

  if (!plans.length) {
    throw new Error("TENANT_CONTENT_INVALID:plans_empty");
  }

  const body =
    resolveMessageBody(
      runtime,
      menuOption?.messageKey,
      menuOption?.fallbackMessageKey || "planSelectionPrompt"
    ) ||
    ensureRequiredString(
      getMessages(runtime)?.planSelectionPrompt,
      "TENANT_CONTENT_INVALID:messages.planSelectionPrompt"
    );

  const buttonText = ensureRequiredString(
    menuOption?.buttonText ||
      getMessages(runtime)?.planMenuButtonText ||
      getMessages(runtime)?.listButtonText,
    "TENANT_CONTENT_INVALID:messages.planMenuButtonText"
  );

  const sectionTitle =
    readString(menuOption?.sectionTitle) ||
    readString(getMessages(runtime)?.planMenuTitle);

  await sendListMessage({
    tenantId,
    runtime,
    to: phone,
    phoneNumberId,
    body,
    buttonText,
    sections: buildPlanSections(plans, sectionTitle),
  });

  await setState(tenantId, phone, targetState);

  audit("ACTION_PLAN_MENU_RENDERED", {
    tenantId,
    state: targetState,
    planCount: plans.length,
  });

  return true;
}

export async function actionSelectPlan(flowCtx) {
  const { tenantId, phone, runtime, menuOption } = flowCtx;

  const planId = ensureRequiredString(
    menuOption?.planId,
    "TENANT_CONTENT_INVALID:planId_missing"
  );

  const targetState = assertKnownState(runtime, resolvePlanMenuState(menuOption));

  const plan = findPlanById(runtime, planId);
  assertPlanIsActionReady(plan, runtime);

  await setState(tenantId, phone, targetState);

  Object.assign(flowCtx, buildPlanSelectionFlowCtx(flowCtx, plan.id, targetState));

  audit("ACTION_SELECT_PLAN_PREPARED", {
    tenantId,
    state: targetState,
    planId: readString(plan.id),
    planKey: readString(plan.key),
  });

  return false;
}

export async function actionSelectCurrentPlan(flowCtx) {
  const { tenantId, phone, runtime, menuOption } = flowCtx;

  const planKey = ensureRequiredString(
    menuOption?.planKey,
    "TENANT_CONTENT_INVALID:planKey_missing"
  );

  const targetState = assertKnownState(runtime, resolvePlanMenuState(menuOption));

  const plan = findPlanByKey(runtime, planKey);
  assertPlanIsActionReady(plan, runtime);

  await setState(tenantId, phone, targetState);

  Object.assign(flowCtx, buildPlanSelectionFlowCtx(flowCtx, plan.id, targetState));

  audit("ACTION_SELECT_CURRENT_PLAN_PREPARED", {
    tenantId,
    state: targetState,
    planId: readString(plan.id),
    planKey: readString(plan.key),
  });

  return false;
}

export async function actionGoState(flowCtx) {
  const { tenantId, runtime, phone, menuOption } = flowCtx;

  const targetState = assertKnownState(
    runtime,
    ensureRequiredString(
      menuOption?.targetState,
      "TENANT_CONTENT_INVALID:targetState_missing"
    )
  );

  audit("ACTION_GO_STATE", {
    tenantId,
    fromState: flowCtx?.state || null,
    targetState,
  });

  await setState(tenantId, phone, targetState);

  await renderState({
    ...flowCtx,
    state: targetState,
    raw: "",
    upper: "",
    digits: "",
  });

  return true;
}

export async function actionShowMessage(flowCtx) {
  const { tenantId, runtime, phone, phoneNumberId, menuOption } = flowCtx;

  const messageKey = ensureRequiredString(
    menuOption?.messageKey,
    "TENANT_CONTENT_INVALID:messageKey_missing"
  );

  const body = ensureRequiredString(
    getMessages(runtime)?.[messageKey],
    `TENANT_CONTENT_INVALID:messages.${messageKey}`
  );

  const nextState = readString(menuOption?.targetState)
    ? assertKnownState(runtime, menuOption.targetState)
    : null;

  await sendAndSetState({
    tenantId,
    runtime,
    phone,
    body,
    state: nextState,
    phoneNumberId,
  });

  audit("ACTION_SHOW_MESSAGE", {
    tenantId,
    messageKey,
    nextState,
  });

  return true;
}
