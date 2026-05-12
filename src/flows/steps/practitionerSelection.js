import { getSession, setState, updateSession } from "../../session/redisSession.js";
import { sendListMessage } from "../../whatsapp/sendListMessage.js";
import { audit } from "../../observability/audit.js";
import { sanitizeForLog } from "../../utils/logSanitizer.js";
import { maskPhone } from "../../utils/mask.js";

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getMessages(runtime) {
  return isObject(runtime?.content?.messages) ? runtime.content.messages : {};
}

function getPractitioners(runtime) {
  return Array.isArray(runtime?.practitioners)
    ? runtime.practitioners.filter((item) => isObject(item) && item.active === true)
    : [];
}

function getPlans(runtime) {
  return Array.isArray(runtime?.content?.plans) ? runtime.content.plans : [];
}

function findSelectedPlan(runtime, booking) {
  const planId = readString(booking?.planId);
  const planKey = readString(booking?.planKey);

  return (
    getPlans(runtime).find((plan) => readString(plan?.id) === planId) ||
    getPlans(runtime).find((plan) => readString(plan?.key) === planKey) ||
    null
  );
}

function normalizeIdList(value) {
  return Array.isArray(value)
    ? value.map((item) => readString(item)).filter(Boolean)
    : [];
}

function resolveAllowedPractitioners(runtime, booking) {
  const all = getPractitioners(runtime);
  const allowedIds = normalizeIdList(booking?.practitionerIds);

  if (!allowedIds.length) return all;

  const allowedSet = new Set(allowedIds);
  return all.filter((item) => allowedSet.has(readString(item?.practitionerId)));
}

function buildRows(practitioners) {
  return practitioners.map((item) => ({
    id: `PRACTITIONER_${readString(item.practitionerId)}`,
    title: readString(item.label) || readString(item.practitionerKey),
    description: "",
  }));
}

function parsePractitionerId(raw) {
  const value = readString(raw);
  if (!value.startsWith("PRACTITIONER_")) return "";
  return value.slice("PRACTITIONER_".length);
}

async function renderPractitionerList(flowCtx, practitioners) {
  const { tenantId, runtime, phone, phoneNumberId } = flowCtx;
  const messages = getMessages(runtime);

  await sendListMessage({
    tenantId,
    runtime,
    to: phone,
    phoneNumberId,
    body:
      readString(messages.practitionerSelectionPrompt) ||
      "Escolha o profissional para este agendamento:",
    buttonText:
      readString(messages.practitionerSelectionButtonText) ||
      readString(messages.listButtonText) ||
      "Selecionar",
    sections: [
      {
        title:
          readString(messages.practitionerSelectionSectionTitle) ||
          "Profissionais",
        rows: buildRows(practitioners),
      },
    ],
  });

  return true;
}

export async function handlePractitionerSelectionStep(flowCtx) {
  const { tenantId, runtime, phone, phoneNumberId, raw, MSG, services, traceId } =
    flowCtx;

  const sessionObj = await getSession(tenantId, phone);
  const booking = isObject(sessionObj?.booking) ? sessionObj.booking : null;

  if (!booking || readString(booking.practitionerMode) !== "USER_SELECT") {
    await services.sendText({
      tenantId,
      to: phone,
      body: MSG.BOOKING_SESSION_INVALID,
      phoneNumberId,
    });

    await setState(tenantId, phone, "MAIN");
    return true;
  }

  const plan = findSelectedPlan(runtime, booking);
  if (!plan) {
    await services.sendText({
      tenantId,
      to: phone,
      body: MSG.BOOKING_SESSION_INVALID,
      phoneNumberId,
    });

    await setState(tenantId, phone, "MAIN");
    return true;
  }

  const practitioners = resolveAllowedPractitioners(runtime, booking);

  if (!practitioners.length) {
    await services.sendText({
      tenantId,
      to: phone,
      body: MSG.BOOKING_SESSION_INVALID,
      phoneNumberId,
    });

    await setState(tenantId, phone, "MAIN");
    return true;
  }

  const selectedPractitionerId = parsePractitionerId(raw);

  if (!selectedPractitionerId) {
    return await renderPractitionerList(flowCtx, practitioners);
  }

  const selected = practitioners.find(
    (item) => readString(item.practitionerId) === selectedPractitionerId
  );

  if (!selected) {
    await services.sendText({
      tenantId,
      to: phone,
      body:
        readString(runtime?.content?.messages?.practitionerSelectionInvalid) ||
        MSG.BUTTONS_ONLY_WARNING,
      phoneNumberId,
    });

    return await renderPractitionerList(flowCtx, practitioners);
  }

  const nextState = readString(booking.practitionerNextState) || "LGPD_CONSENT";

  await updateSession(tenantId, phone, (sess) => {
    sess.booking = sess.booking || {};
    sess.booking.practitionerId = selectedPractitionerId;
    delete sess.booking.practitionerNextState;
    delete sess.pending;
  });

  audit(
    "PRACTITIONER_SELECTED",
    sanitizeForLog({
      tenantId,
      traceId,
      tracePhone: maskPhone(phone),
      practitionerId: selectedPractitionerId,
      planId: readString(booking.planId),
      planKey: readString(booking.planKey),
      nextState,
    })
  );

  await setState(tenantId, phone, nextState);

  return await services.renderState(
    {
      ...flowCtx,
      state: nextState,
      raw: "",
      upper: "",
      digits: "",
    },
    nextState
  );
}
