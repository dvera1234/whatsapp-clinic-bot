import { updateSession } from "../../session/redisSession.js";
import {
  LGPD_TEXT_VERSION,
  LGPD_TEXT_HASH,
} from "../../config/constants.js";
import { audit } from "../../observability/audit.js";
import { maskPhone } from "../../utils/mask.js";
import { resetToMain, sendAndSetState } from "../helpers/flowHelpers.js";

// =========================
// HELPERS
// =========================

function getMenu(runtime) {
  return runtime?.content?.menu || {};
}

function getPlans(runtime) {
  return Array.isArray(runtime?.content?.plans)
    ? runtime.content.plans
    : [];
}

function buildMainMenu(runtime) {
  const menu = getMenu(runtime);

  const title = menu.prompt || "Menu:";
  const options = Array.isArray(menu.options) ? menu.options : [];

  const lines = options.map((opt) => `${opt.id}) ${opt.label}`);

  return [title, lines.join("\n")]
    .filter(Boolean)
    .join("\n\n");
}

function buildPlansMenu(runtime) {
  const plans = getPlans(runtime);

  const title =
    runtime?.content?.messages?.planSelectionPrompt ||
    "Selecione uma opção:";

  const lines = plans.map((p) => `${p.id}) ${p.label}`);
  const footer = "0) Voltar ao menu inicial";

  return [title, lines.join("\n"), footer]
    .filter(Boolean)
    .join("\n\n");
}

function findMenuOption(runtime, digits) {
  const menu = getMenu(runtime);
  const options = Array.isArray(menu.options) ? menu.options : [];
  return options.find((opt) => String(opt.id) === String(digits)) || null;
}

function findPlan(runtime, digits) {
  const plans = getPlans(runtime);
  return plans.find((p) => String(p.id) === String(digits)) || null;
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
}) {
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
    body: runtime?.content?.messages?.lgpdConsent,
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
  } = flowCtx;

  // =========================
  // MAIN MENU DINÂMICO
  // =========================

  if (state === "MAIN") {
    const option = findMenuOption(runtime, digits);

    if (!option) {
      await sendAndSetState({
        tenantId,
        phone,
        body: buildMainMenu(runtime),
        state: "MAIN",
        phoneNumberIdFallback,
      });
      return true;
    }

    switch (option.action) {
      case "PLAN_MENU":
        await sendAndSetState({
          tenantId,
          phone,
          body: buildPlansMenu(runtime),
          state: "PLAN_PICK",
          phoneNumberIdFallback,
        });
        return true;

      case "POS":
        await sendAndSetState({
          tenantId,
          phone,
          body: runtime?.content?.messages?.posMenu,
          state: "POS",
          phoneNumberIdFallback,
        });
        return true;

      case "ATTENDANT":
        await sendAndSetState({
          tenantId,
          phone,
          body: runtime?.content?.messages?.attendant,
          state: "ATENDENTE",
          phoneNumberIdFallback,
        });
        return true;

      default:
        await sendAndSetState({
          tenantId,
          phone,
          body: buildMainMenu(runtime),
          state: "MAIN",
          phoneNumberIdFallback,
        });
        return true;
    }
  }

  // =========================
  // PLAN PICK
  // =========================

  if (state === "PLAN_PICK") {
    if (digits === "0") {
      await resetToMain(tenantId, phone, phoneNumberIdFallback, runtime?.content?.messages);
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
      const msg = runtime?.content?.messages?.[plan.messageKey] || "";

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
    }

    await startBooking({
      tenantId,
      traceId,
      phone,
      phoneNumberIdFallback,
      practitionerId,
      planKey: plan.key,
      runtime,
    });

    return true;
  }

  return false;
}
