import { getSession, setState, updateSession } from "../../session/redisSession.js";
import { finishWizardAndGoToDates } from "../helpers/bookingHelpers.js";

function findPlan(runtime, digits) {
  const plans = runtime?.content?.plans || [];
  return plans.find(p => p.id === String(digits)) || null;
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

  if (digits === "0") {
    await setState(tenantId, phone, "MAIN");
    await services.sendText({
      tenantId,
      to: phone,
      body: MSG.MENU,
      phoneNumberIdFallback,
    });
    return true;
  }

  const plan = findPlan(runtime, digits);

  if (!plan) {
    await services.sendText({
      tenantId,
      to: phone,
      body: MSG.BUTTONS_ONLY_WARNING,
      phoneNumberIdFallback,
    });
    return true;
  }

  // INFO ONLY
  if (plan.flow === "INFO_ONLY") {
    const msg = resolveMessage(runtime, MSG, plan.messageKey);

    await services.sendText({
      tenantId,
      to: phone,
      body: msg,
      phoneNumberIdFallback,
    });

    return true;
  }

  // BOOKING OU DIRECT_BOOKING → mesmo fluxo
  await updateSession(tenantId, phone, (s) => {
    s.booking = s.booking || {};
    s.booking.planKey = plan.key;

    if (s.portal?.issue) delete s.portal.issue;
  });

  const s = await getSession(tenantId, phone);
  const patientId = Number(s?.booking?.patientId || s?.portal?.patientId);

  if (!patientId) {
    await services.sendText({
      tenantId,
      to: phone,
      body: MSG.BOOKING_SESSION_INVALID,
      phoneNumberIdFallback,
    });
    await setState(tenantId, phone, "MAIN");
    return true;
  }

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
