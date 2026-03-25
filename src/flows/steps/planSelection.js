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

  const sCurrent = await getSession(tenantId, phone);
  const lockedPlanKey = sCurrent?.booking?.planKey || null;
  
  let chosenKey = null;
  
  if (upper === "PLAN_USE_PRIVATE") {
    chosenKey = PLAN_KEYS.PRIVATE;
  } else if (upper === "PLAN_USE_INSURED" || upper === "PLAN_USE_INSURED_ACCEPTED") {
    chosenKey = PLAN_KEYS.INSURED;
  } else if (upper === "MENU_PRINCIPAL") {
    await setState(tenantId, phone, "MAIN");
    await services.sendText({
      tenantId,
      to: phone,
      body: MSG.MENU || "Menu",
      phoneNumberIdFallback,
    });
    return true;
  } else if (lockedPlanKey === PLAN_KEYS.PRIVATE) {
    chosenKey = PLAN_KEYS.PRIVATE;
  } else if (lockedPlanKey === PLAN_KEYS.INSURED) {
    chosenKey = PLAN_KEYS.INSURED;
  }
  
  if (!chosenKey) {
    await services.sendText({
      tenantId,
      to: phone,
      body: MSG.BUTTONS_ONLY_WARNING,
      phoneNumberIdFallback,
    });
    return true;
  }

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
