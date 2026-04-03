import { getSession, setState, updateSession } from "../../session/redisSession.js";
import { finishWizardAndGoToDates } from "../helpers/bookingHelpers.js";

function getPlans(runtime) {
  return Array.isArray(runtime?.content?.plans)
    ? runtime.content.plans
    : [];
}

function findPlanByInput(runtime, digits) {
  const plans = getPlans(runtime);
  return plans.find((p) => String(p.id) === String(digits)) || null;
}

function resolveMessage(runtime, MSG, key) {
  if (!key) return "";
  return runtime?.content?.messages?.[key] || MSG?.[key] || "";
}

export async function handlePlanSelectionStep(flowCtx) {
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
    adapters,
    services,
  } = flowCtx;

  if (state !== "PLAN_PICK") return false;

  // 🔙 VOLTAR MENU
  if (digits === "0") {
    await setState(tenantId, phone, "MAIN");

    const menuMsg =
      runtime?.content?.messages?.menu ||
      MSG?.MENU ||
      "Menu";

    await services.sendText({
      tenantId,
      to: phone,
      body: menuMsg,
      phoneNumberIdFallback,
    });

    return true;
  }

  const plan = findPlanByInput(runtime, digits);

  // ❌ INPUT INVÁLIDO
  if (!plan) {
    await services.sendText({
      tenantId,
      to: phone,
      body:
        runtime?.content?.messages?.buttonsOnlyWarning ||
        MSG?.BUTTONS_ONLY_WARNING,
      phoneNumberIdFallback,
    });
    return true;
  }

  // 📄 INFO ONLY (NÃO SEGUE FLUXO)
  if (plan.flow === "INFO_ONLY") {
    const msg = resolveMessage(runtime, MSG, plan.messageKey);

    if (msg) {
      await services.sendText({
        tenantId,
        to: phone,
        body: msg,
        phoneNumberIdFallback,
      });
    }

    return true;
  }

  // 📅 BOOKING / DIRECT_BOOKING
  await updateSession(tenantId, phone, (s) => {
    s.booking = s.booking || {};
    s.booking.planKey = plan.key;

    if (s.portal?.issue) {
      delete s.portal.issue;
    }
  });

  const s = await getSession(tenantId, phone);
  const patientId = Number(s?.booking?.patientId || s?.portal?.patientId);

  // ❌ SESSÃO INVÁLIDA
  if (!patientId) {
    await services.sendText({
      tenantId,
      to: phone,
      body:
        runtime?.content?.messages?.bookingSessionInvalid ||
        MSG?.BOOKING_SESSION_INVALID,
      phoneNumberIdFallback,
    });

    await setState(tenantId, phone, "MAIN");
    return true;
  }

  // 🚀 SEGUE PARA DATAS
  await finishWizardAndGoToDates({
    schedulingAdapter: adapters.schedulingAdapter,
    tenantId,
    runtime,
    phone,
    phoneNumberIdFallback,
    patientId,
    planKeyFromWizard: plan.key,
    traceId,
    practitionerId,
    MSG,
    services,
  });

  return true;
}
