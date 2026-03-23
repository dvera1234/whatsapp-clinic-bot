import { getSession, setState, updateSession } from "../../session/redisSession.js";
import { PLAN_KEYS } from "../../config/constants.js";
import { finishWizardAndGoToDates } from "../helpers/bookingHelpers.js";

export async function handlePlanSelectionStep(flowCtx) {
  const {
    tenantId,
    runtime,
    traceId,
    phone,
    phoneNumberIdFallback,
    upper,
    state,
    MSG,
    practitionerId,
    adapters,
    services,
  } = flowCtx;

  if (state !== "PLAN_PICK") {
    return false;
  }

  if (upper !== "PLAN_USE_PRIVATE" && upper !== "PLAN_USE_INSURED") {
    await services.sendText({
      tenantId,
      to: phone,
      body: MSG.BUTTONS_ONLY_WARNING,
      phoneNumberIdFallback,
    });
    return true;
  }

  const chosenKey =
    upper === "PLAN_USE_INSURED" ? PLAN_KEYS.INSURED : PLAN_KEYS.PRIVATE;

  await updateSession(tenantId, phone, (sess) => {
    sess.booking = sess.booking || {};
    sess.booking.planKey = chosenKey;

    if (sess.portal?.issue) {
      delete sess.portal.issue;
    }
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
    planKeyFromWizard: chosenKey,
    traceId,
    practitionerId,
    MSG,
    services,
  });

  return true;
}
