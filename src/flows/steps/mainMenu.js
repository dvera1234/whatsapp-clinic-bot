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

function buildPlansMenu(runtime, MSG) {
  const plans = getPlans(runtime);

  const title =
    MSG.PLAN_SELECTION_PROMPT ||
    "Selecione uma opção:";

  const lines = plans.map((p) => `${p.id}) ${p.label}`);
  const footer = "0) Voltar ao menu inicial";

  return [title, lines.join("\n"), footer]
    .filter(Boolean)
    .join("\n\n");
}

function findPlan(runtime, digits) {
  const plans = getPlans(runtime);
  return plans.find((p) => p.id === String(digits)) || null;
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
  MSG,
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
    body: MSG.LGPD_CONSENT,
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
    MSG,
    practitionerId,
  } = flowCtx;

  // =========================
  // MAIN MENU
  // =========================

  if (state === "MAIN") {
    if (digits === "1") {
      await sendAndSetState({
        tenantId,
        phone,
        body: buildPlansMenu(runtime, MSG),
        state: "PLAN_PICK",
        phoneNumberIdFallback,
      });
      return true;
    }

    if (digits === "3") {
      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.POS_MENU,
        state: "POS",
        phoneNumberIdFallback,
      });
      return true;
    }

    if (digits === "4") {
      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.ATENDENTE,
        state: "ATENDENTE",
        phoneNumberIdFallback,
      });
      return true;
    }

    await sendAndSetState({
      tenantId,
      phone,
      body: MSG.MENU,
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
      await resetToMain(tenantId, phone, phoneNumberIdFallback, MSG);
      return true;
    }

    const plan = findPlan(runtime, digits);

    if (!plan) {
      await sendAndSetState({
        tenantId,
        phone,
        body: buildPlansMenu(runtime, MSG),
        state: "PLAN_PICK",
        phoneNumberIdFallback,
      });
      return true;
    }

    // INFO ONLY → só mostra mensagem
    if (plan.flow === "INFO_ONLY") {
      const tenantMessages = getTenantMessages(runtime);
      const msg =
        tenantMessages?.[plan.messageKey] ||
        MSG?.[plan.messageKey] ||
        "";

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

    // BOOKING / DIRECT_BOOKING
    await startBooking({
      tenantId,
      traceId,
      phone,
      phoneNumberIdFallback,
      practitionerId,
      planKey: plan.key,
      MSG,
    });

    return true;
  }

  return false;
}
