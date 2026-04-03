import { updateSession } from "../../session/redisSession.js";
import {
  LGPD_TEXT_VERSION,
  LGPD_TEXT_HASH,
} from "../../config/constants.js";
import { audit } from "../../observability/audit.js";
import { maskPhone } from "../../utils/mask.js";
import { resetToMain, sendAndSetState } from "../helpers/flowHelpers.js";
import { dispatchAction } from "../actions/actionDispatcher.js";

// =========================
// HELPERS
// =========================

function getTenantMessages(runtime) {
  return runtime?.content?.messages || {};
}

function getMenu(runtime) {
  return runtime?.content?.menu || {};
}

function getPlans(runtime) {
  return Array.isArray(runtime?.content?.plans)
    ? runtime.content.plans
    : [];
}

// 🔥 BOTÕES WHATSAPP
async function sendMainMenuWithButtons({
  tenantId,
  phone,
  runtime,
  phoneNumberIdFallback,
  services,
}) {
  const menu = getMenu(runtime);
  const title = String(menu?.text || "").trim();
  const options = Array.isArray(menu?.options) ? menu.options : [];

  const buttons = options
    .filter(
      (opt) =>
        opt &&
        String(opt.id || "").trim() &&
        String(opt.label || "").trim()
    )
    .slice(0, 3) // limite WhatsApp
    .map((opt) => ({
      id: String(opt.id),
      title: String(opt.label).slice(0, 20),
    }));

  // tenta enviar botões
  try {
    if (buttons.length > 0) {
      await services.sendButtons({
        tenantId,
        to: phone,
        body: title,
        buttons,
        phoneNumberIdFallback,
      });
      return true;
    }
  } catch (e) {
    // fallback automático
  }

  return false;
}

function buildMainMenu(runtime) {
  const menu = getMenu(runtime);

  const title = String(menu?.text || "").trim();
  const options = Array.isArray(menu?.options) ? menu.options : [];

  const lines = options
    .map((opt) => `${opt.id}) ${opt.label}`)
    .join("\n");

  return [title, lines].filter(Boolean).join("\n\n");
}

function buildPlansMenu(runtime) {
  const messages = getTenantMessages(runtime);
  const plans = getPlans(runtime);

  const title = String(
    messages?.planSelectionPrompt || "Selecione uma opção:"
  ).trim();

  const lines = plans
    .map((plan) => `${plan.id}) ${plan.label}`)
    .join("\n");

  const footer = String(
    messages?.planMenuFooter || "0) Voltar ao menu inicial"
  ).trim();

  return [title, lines, footer].filter(Boolean).join("\n\n");
}

function findMenuOption(runtime, digits) {
  const options = runtime?.content?.menu?.options || [];

  return options.find((opt) => opt.id === String(digits)) || null;
}

function findPlan(runtime, digits) {
  const plans = getPlans(runtime);
  return plans.find((plan) => plan.id === String(digits)) || null;
}

// =========================
// BOOKING START
// =========================

async function startBooking({
  tenantId,
  traceId,
  phone,
  phoneNumberIdFallback,
  practitionerId,
  planKey,
  runtime,
  services,
}) {
  const messages = getTenantMessages(runtime);

  await updateSession(tenantId, phone, (s) => {
    s.booking = {
      ...(s.booking || {}),
      planKey,
      practitionerId,
      patientId: null,
      appointmentDate: null,
      slots: [],
      pageIndex: 0,
      isReturn: false,
    };

    s.portal = {
      step: "CPF",
      patientId: null,
      exists: false,
      form: {},
    };
  });

  audit("LGPD_NOTICE_PRESENTED", {
    tenantId,
    traceId,
    tracePhone: maskPhone(phone),
    consentTextVersion: LGPD_TEXT_VERSION,
    consentTextHash: LGPD_TEXT_HASH,
    timestamp: new Date().toISOString(),
  });

  await sendAndSetState({
    tenantId,
    phone,
    body: messages?.lgpdConsent,
    state: "LGPD_CONSENT",
    phoneNumberIdFallback,
  });
}

// =========================
// MAIN HANDLER
// =========================

export async function handleMainMenuStep(flowCtx) {
  const {
    tenantId,
    runtime,
    traceId,
    phone,
    phoneNumberIdFallback,
    digits,
    state,
    practitionerId,
    services,
  } = flowCtx;

  const messages = getTenantMessages(runtime);

  // =========================
  // MAIN MENU
  // =========================

  if (state === "MAIN") {
    const option = findMenuOption(runtime, digits);

    if (!option) {
      const sentButtons = await sendMainMenuWithButtons({
        tenantId,
        phone,
        runtime,
        phoneNumberIdFallback,
        services,
      });

      if (!sentButtons) {
        await sendAndSetState({
          tenantId,
          phone,
          body: buildMainMenu(runtime),
          state: "MAIN",
          phoneNumberIdFallback,
        });
      }

      return true;
    }

    const dispatched = await dispatchAction(option.action, {
      ...flowCtx,
      menuOption: option,
      helpers: {
        buildPlansMenu,
      },
    });

    if (dispatched) return true;

    await sendAndSetState({
      tenantId,
      phone,
      body: buildMainMenu(runtime),
      state: "MAIN",
      phoneNumberIdFallback,
    });

    return true;
  }

  // =========================
  // PLAN PICK
  // =========================

  if (state === "PLAN_PICK") {
    if (digits === "0") {
      await resetToMain(tenantId, phone, phoneNumberIdFallback, messages);
      return true;
    }

    const plan = findPlan(runtime, digits);

    if (!plan) {
      await sendAndSetState({
        tenantId,
        phone,
        body: buildPlansMenu(runtime),
        state: "PLAN_PICK",
        phoneNumberIdFallback,
      });
      return true;
    }

    if (plan.flow === "INFO_ONLY") {
      const msg = messages?.[plan.messageKey];

      if (msg) {
        await sendAndSetState({
          tenantId,
          phone,
          body: msg,
          state: "PLAN_PICK",
          phoneNumberIdFallback,
        });
        return true;
      }

      return true;
    }

    await startBooking({
      tenantId,
      traceId,
      phone,
      phoneNumberIdFallback,
      practitionerId,
      planKey: plan.key,
      runtime,
      services,
    });

    return true;
  }

  return false;
}
