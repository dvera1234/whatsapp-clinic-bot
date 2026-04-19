import { setState } from "../../session/redisSession.js";
import { sendListMessage } from "../../whatsapp/sendListMessage.js";
import { resetToMain, sendAndSetState } from "../helpers/flowHelpers.js";
import { renderState } from "../helpers/stateRenderHelpers.js";

// =========================
// HELPERS
// =========================

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

  return [
    {
      title:
        String(menuLike?.sectionTitle || "").trim() ||
        "Opções disponíveis",
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

// =========================
// ACTIONS
// =========================

export async function actionOpenSubmenu(flowCtx) {
  const { tenantId, runtime, phone, phoneNumberId, menuOption } = flowCtx;

  const submenuKey = String(menuOption?.target || "").trim();
  if (!submenuKey) {
    throw new Error("TENANT_CONTENT_INVALID:submenu_target_missing");
  }

  const submenu = getSubmenu(runtime, submenuKey);
  if (!submenu) {
    throw new Error(`TENANT_CONTENT_INVALID:submenu_missing:${submenuKey}`);
  }

  await sendListMessage({
    tenantId,
    to: phone,
    phoneNumberId,
    body: String(submenu.text || ""),
    buttonText: submenu.buttonText || "Selecionar",
    sections: buildSections(submenu, `submenus.${submenuKey}`),
  });

  await setState(tenantId, phone, getMenuStateKey(submenuKey));
  return true;
}

export async function actionGoMain(flowCtx) {
  return await resetToMain(flowCtx);
}

export async function actionPlanMenu(flowCtx) {
  const { tenantId, phone, runtime, phoneNumberId } = flowCtx;

  const plans = Array.isArray(runtime?.content?.plans)
    ? runtime.content.plans
    : [];

  if (!plans.length) {
    throw new Error("TENANT_CONTENT_INVALID:plans_empty");
  }

  await sendListMessage({
    tenantId,
    to: phone,
    phoneNumberId,
    body:
      runtime?.content?.messages?.planSelectionPrompt ||
      "Selecione uma opção:",
    buttonText:
      runtime?.content?.messages?.bookingOptionsButton || "Selecionar",
    sections: [
      {
        title:
          runtime?.content?.messages?.insuranceMenuTitle ||
          "Opções disponíveis",
        rows: plans.map((plan) => ({
          id: String(plan.id),
          title: String(plan.label || plan.id),
          description: String(plan.description || ""),
        })),
      },
    ],
  });

  await setState(tenantId, phone, "PLAN_PICK");
  return true;
}

// 🔥 FINAL CORRETO
export async function actionSelectPlan(flowCtx) {
  const { tenantId, phone, menuOption } = flowCtx;

  const planId = String(menuOption?.planId || "").trim();

  if (!planId) {
    throw new Error("TENANT_CONTENT_INVALID:planId_missing");
  }

  // apenas muda estado + injeta raw
  await setState(tenantId, phone, "PLAN_PICK");

  flowCtx.raw = planId;
  flowCtx.upper = planId.toUpperCase();
  flowCtx.digits = "";

  return false; // deixa pipeline continuar
}

// 🔥 FINAL CORRETO
export async function actionSelectCurrentPlan(flowCtx) {
  const { tenantId, phone, menuOption, runtime } = flowCtx;

  const planKey = String(menuOption?.planKey || "").trim();

  if (!planKey) {
    throw new Error("TENANT_CONTENT_INVALID:planKey_missing");
  }

  const plan = runtime?.content?.plans?.find(
    (p) => String(p.key) === planKey
  );

  if (!plan) {
    throw new Error("TENANT_CONTENT_INVALID:plan_not_found");
  }

  await setState(tenantId, phone, "PLAN_PICK");

  flowCtx.raw = String(plan.id);
  flowCtx.upper = String(plan.id).toUpperCase();
  flowCtx.digits = "";

  return false;
}

export async function actionGoState(flowCtx) {
  const { tenantId, phone, menuOption } = flowCtx;

  const targetState = String(menuOption?.targetState || "").trim();

  if (!targetState) {
    throw new Error("TENANT_CONTENT_INVALID:targetState_missing");
  }

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

  const messageKey = String(menuOption?.messageKey || "").trim();

  if (!messageKey) {
    throw new Error("TENANT_CONTENT_INVALID:messageKey_missing");
  }

  const body = runtime?.content?.messages?.[messageKey];

  if (!body) {
    throw new Error(`TENANT_CONTENT_INVALID:messages.${messageKey}`);
  }

  await sendAndSetState({
    tenantId,
    phone,
    body,
    state: null,
    phoneNumberId,
  });

  return true;
}
