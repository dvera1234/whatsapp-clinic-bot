import { setState } from "../../session/redisSession.js";
import { sendListMessage } from "../../whatsapp/sendListMessage.js";
import { resetToMain, sendAndSetState } from "../helpers/flowHelpers.js";
import { renderState } from "../helpers/stateRenderHelpers.js";
import { handlePlanSelectionStep } from "../steps/planSelection.js";

// =========================
// HELPERS
// =========================

function getMenu(runtime) {
  return runtime?.content?.menu || null;
}

function getSubmenus(runtime) {
  return runtime?.content?.submenus || {};
}

function getSubmenu(runtime, key) {
  return getSubmenus(runtime)?.[key] || null;
}

function ensureOptions(menuLike, fieldName) {
  const options = Array.isArray(menuLike?.options) ? menuLike.options : [];
  if (!options.length) {
    throw new Error(`TENANT_CONTENT_INVALID:${fieldName}.options_empty`);
  }
  return options;
}

function buildSections(menuLike, fieldName = "menu") {
  const options = ensureOptions(menuLike, fieldName);
  const sectionTitle =
    String(menuLike?.sectionTitle || "").trim() || "Opções disponíveis";

  return [
    {
      title: sectionTitle,
      rows: options.map((opt) => ({
        id: String(opt.id),
        title: String(opt.label || opt.id),
        description: String(opt.description || "").trim(),
      })),
    },
  ];
}

function getMenuStateKey(submenuKey) {
  return `MENU:${String(submenuKey || "").trim()}`;
}

function filterPlans(plans, filter) {
  const normalized = String(filter || "").trim().toUpperCase();

  if (!normalized) return plans;

  if (normalized === "PRIVATE_ONLY") {
    return plans.filter((plan) => String(plan?.key || "").trim() === "PRIVATE");
  }

  if (normalized === "INSURED_ONLY") {
    return plans.filter((plan) => String(plan?.key || "").trim() !== "PRIVATE");
  }

  return plans;
}

// =========================
// ACTIONS
// =========================

export async function actionOpenSubmenu(flowCtx) {
  const {
    tenantId,
    runtime,
    phone,
    phoneNumberIdFallback,
    menuOption,
  } = flowCtx;

  const submenuKey = String(menuOption?.target || "").trim();
  if (!submenuKey) {
    throw new Error("TENANT_CONTENT_INVALID:submenu_target_missing");
  }

  const submenu = getSubmenu(runtime, submenuKey);
  if (!submenu || typeof submenu !== "object") {
    throw new Error(`TENANT_CONTENT_INVALID:submenu_missing:${submenuKey}`);
  }

  const body = String(submenu?.text || "").trim();
  if (!body) {
    throw new Error(`TENANT_CONTENT_INVALID:submenu_text_missing:${submenuKey}`);
  }

  await sendListMessage({
    tenantId,
    to: phone,
    phoneNumberId: phoneNumberIdFallback,
    body,
    buttonText: String(submenu?.buttonText || "").trim() || "Selecionar",
    sections: buildSections(submenu, `submenus.${submenuKey}`),
  });

  await setState(tenantId, phone, getMenuStateKey(submenuKey));
  return true;
}

export async function actionGoMain(flowCtx) {
  return await resetToMain(flowCtx);
}

export async function actionPlanMenu(flowCtx) {
  const {
    tenantId,
    phone,
    runtime,
    phoneNumberIdFallback,
    menuOption,
  } = flowCtx;

  const plans = Array.isArray(runtime?.content?.plans)
    ? runtime.content.plans
    : [];

  if (!plans.length) {
    throw new Error("TENANT_CONTENT_INVALID:plans_empty");
  }

  const filteredPlans = filterPlans(plans, menuOption?.filter);

  if (!filteredPlans.length) {
    throw new Error("TENANT_CONTENT_INVALID:plans_filtered_empty");
  }

  const body =
    runtime?.content?.messages?.planSelectionPrompt ||
    "Selecione uma opção:";

  await sendListMessage({
    tenantId,
    to: phone,
    phoneNumberId: phoneNumberIdFallback,
    body,
    buttonText:
      String(runtime?.content?.messages?.bookingOptionsButton || "").trim() ||
      "Selecionar",
    sections: [
      {
        title:
          String(runtime?.content?.messages?.insuranceMenuTitle || "").trim() ||
          "Opções disponíveis",
        rows: filteredPlans.map((plan) => ({
          id: String(plan.id),
          title: String(plan.label || plan.id),
          description: String(plan.description || "").trim(),
        })),
      },
    ],
  });

  await setState(tenantId, phone, "PLAN_PICK");
  return true;
}

// 🔥 NOVO — SELECT_PLAN (corrige teu bug)
export async function actionSelectPlan(flowCtx) {
  const {
    tenantId,
    phone,
    menuOption,
  } = flowCtx;

  const planId = String(menuOption?.planId || "").trim();
  if (!planId) {
    throw new Error("TENANT_CONTENT_INVALID:planId_missing");
  }

  await setState(tenantId, phone, "PLAN_PICK");

  return await handlePlanSelectionStep({
    ...flowCtx,
    raw: planId,
    upper: planId.toUpperCase(),
    digits: "",
    state: "PLAN_PICK",
  });
}

// 🔥 NOVO — SELECT_CURRENT_PLAN
export async function actionSelectCurrentPlan(flowCtx) {
  const { runtime, menuOption } = flowCtx;

  const plans = Array.isArray(runtime?.content?.plans)
    ? runtime.content.plans
    : [];

  const currentPlanKey = String(menuOption?.planKey || "").trim();

  let selectedPlan = null;

  if (currentPlanKey) {
    selectedPlan =
      plans.find((p) => String(p?.key || "").trim() === currentPlanKey) || null;
  }

  if (!selectedPlan) {
    selectedPlan =
      plans.find((p) => String(p?.key || "").trim() === "MEDSENIOR") || null;
  }

  if (!selectedPlan?.id) {
    throw new Error("TENANT_CONTENT_INVALID:current_plan_not_resolved");
  }

  await setState(flowCtx.tenantId, flowCtx.phone, "PLAN_PICK");

  return await handlePlanSelectionStep({
    ...flowCtx,
    raw: String(selectedPlan.id),
    upper: String(selectedPlan.id).toUpperCase(),
    digits: "",
    state: "PLAN_PICK",
  });
}

export async function actionGoState(flowCtx) {
  const {
    tenantId,
    runtime,
    phone,
    phoneNumberIdFallback,
    menuOption,
  } = flowCtx;

  const targetState = String(menuOption?.targetState || "").trim();
  if (!targetState) {
    throw new Error("TENANT_CONTENT_INVALID:targetState_missing");
  }

  const messageKey = String(menuOption?.messageKey || "").trim();
  const body =
    messageKey && runtime?.content?.messages?.[messageKey]
      ? runtime.content.messages[messageKey]
      : String(menuOption?.text || "").trim();

  const isRenderableMenuState =
    targetState === "MAIN" || targetState.startsWith("MENU:");

  if (isRenderableMenuState) {
    return await sendAndSetState({
      tenantId,
      phone,
      body: body || null,
      state: targetState,
      phoneNumberIdFallback,
      flowCtx,
    });
  }

  await sendAndSetState({
    tenantId,
    phone,
    body: body || null,
    state: targetState,
    phoneNumberIdFallback,
  });

  return true;
}

export async function actionShowMessage(flowCtx) {
  const {
    tenantId,
    runtime,
    phone,
    phoneNumberIdFallback,
    menuOption,
  } = flowCtx;

  const messageKey = String(menuOption?.messageKey || "").trim();
  if (!messageKey) {
    throw new Error("TENANT_CONTENT_INVALID:messageKey_missing");
  }

  const body = runtime?.content?.messages?.[messageKey];
  if (typeof body !== "string" || !body.trim()) {
    throw new Error(`TENANT_CONTENT_INVALID:messages.${messageKey}`);
  }

  const nextState = menuOption?.nextState
    ? String(menuOption.nextState).trim()
    : null;

  const isRenderableMenuState =
    nextState === "MAIN" || String(nextState || "").startsWith("MENU:");

  if (isRenderableMenuState) {
    return await sendAndSetState({
      tenantId,
      phone,
      body,
      state: nextState,
      phoneNumberIdFallback,
      flowCtx,
    });
  }

  await sendAndSetState({
    tenantId,
    phone,
    body,
    state: nextState || null,
    phoneNumberIdFallback,
  });

  return true;
}
