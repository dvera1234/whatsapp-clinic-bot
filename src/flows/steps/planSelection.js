import { getSession, setState, updateSession } from "../../session/redisSession.js";
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

  const plans = runtime?.content?.plans || [];

  if (!Array.isArray(plans) || plans.length === 0) {
    await services.sendText({
      tenantId,
      to: phone,
      body: "Configuração de planos inválida.",
      phoneNumberIdFallback,
    });
    await setState(tenantId, phone, "MAIN");
    return true;
  }

  const sCurrent = await getSession(tenantId, phone);
  const lockedPlanKey = sCurrent?.booking?.planKey || null;

  let chosenKey = null;

  // 🔥 MATCH DINÂMICO VIA JSON (ID DO BOTÃO)
  const matchedPlan = plans.find((p) => {
    const action = String(p?.action || "").toUpperCase();
    return action === upper;
  });

  if (matchedPlan) {
    chosenKey = matchedPlan.key;
  }

  // 🔁 fallback: manter plano já escolhido
  if (!chosenKey && lockedPlanKey) {
    chosenKey = lockedPlanKey;
  }

  // MENU
  if (upper === "MENU_PRINCIPAL") {
    await setState(tenantId, phone, "MAIN");
    await services.sendText({
      tenantId,
      to: phone,
      body: MSG.MENU,
      phoneNumberIdFallback,
    });
    return true;
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

  // 💾 salva plano na sessão
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
