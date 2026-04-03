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

function getTenantMessages(runtime) {
  return runtime?.content?.messages || {};
}

function getPlans(runtime) {
  return Array.isArray(runtime?.content?.plans)
    ? runtime.content.plans
    : [];
}

function buildPlansMenu(runtime) {
  const messages = getTenantMessages(runtime);
  const plans = getPlans(runtime);

  const title =
    messages.planSelectionPrompt ||
    "Selecione uma opção:";

  const lines = plans.map((p) => `${p.id}) ${p.label}`);
  const footer =
    messages.planMenuFooter ||
    "0) Voltar ao menu inicial";

  return [title, lines.join("\n"), footer]
    .filter(Boolean)
    .join("\n\n");
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
    body: messages.lgpdConsent,
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

  const messages = getTenantMessages(runtime);

  // =========================
  // MAIN MENU
  // =========================

  if (state === "MAIN") {
    if (digits === "1") {
      await sendAndSetState({
        tenantId,
        phone,
        body: buildPlansMenu(runtime),
        state: "PLAN_PICK",
        phoneNumberIdFallback,
      });
      return true;
    }

    if (digits === "3") {
      await sendAndSetState({
        tenantId,
        phone,
        body: messages.posMenu,
        state: "POS",
        phoneNumberIdFallback,
      });
      return true;
    }

    if (digits === "4") {
      await sendAndSetState({
        tenantId,
        phone,
        body: messages.attendant,
        state: "ATENDENTE",
        phoneNumberIdFallback,
      });
      return true;
    }

    await sendAndSetState({
      tenantId,
      phone,
      body: messages.menu,
      state: "MAIN",
      phoneNumberIdFallback,
    });

    return true;
  }

  // =========================
  // PLAN PICK (fallback leve)
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

    // INFO ONLY
    if (plan.flow === "INFO_ONLY") {
      const msg = messages?.[plan.messageKey] || "";

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

    // BOOKING
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
