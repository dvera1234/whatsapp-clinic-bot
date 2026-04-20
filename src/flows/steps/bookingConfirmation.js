import {
  getSession,
  setState,
  updateSession,
  redis,
} from "../../session/redisSession.js";
import { audit } from "../../observability/audit.js";
import { sanitizeForLog } from "../../utils/logSanitizer.js";
import { maskPhone } from "../../utils/mask.js";
import {
  bookingConfirmKey,
  buildBookingSuccessMessage,
  showSlotsPage,
} from "../helpers/bookingHelpers.js";
import {
  handleProviderTemporaryUnavailable,
  isProviderTemporaryUnavailableError,
} from "../helpers/auditHelpers.js";

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resolvePlan(runtime, sessionObj) {
  const plans = Array.isArray(runtime?.content?.plans) ? runtime.content.plans : [];
  const planId = readString(sessionObj?.booking?.planId);
  const planKey = readString(sessionObj?.booking?.planKey);

  if (planId) {
    const byId = plans.find((plan) => readString(plan?.id) === planId);
    if (byId) return byId;
  }

  if (planKey) {
    const byKey = plans.find((plan) => readString(plan?.key) === planKey);
    if (byKey) return byKey;
  }

  return null;
}

async function renderSlotsAgain(flowCtx, sessionObj) {
  await setState(flowCtx.tenantId, flowCtx.phone, "SLOTS");

  await showSlotsPage({
    tenantId: flowCtx.tenantId,
    phone: flowCtx.phone,
    phoneNumberId: flowCtx.phoneNumberId,
    slots: sessionObj?.booking?.slots || [],
    page: readNumber(sessionObj?.booking?.slotPage) ?? 0,
    MSG: flowCtx.MSG,
    services: flowCtx.services,
  });

  return true;
}

export async function handleBookingConfirmationStep(flowCtx) {
  const {
    tenantId,
    traceId,
    phone,
    phoneNumberId,
    upper,
    state,
    MSG,
    adapters,
    runtime,
    runtimeCtx,
    services,
  } = flowCtx;

  if (state !== "WAIT_CONFIRM") return false;

  const sessionObj = await getSession(tenantId, phone);
  const slotId = readNumber(sessionObj?.pending?.slotId);
  const patientId = readNumber(sessionObj?.booking?.patientId);
  const practitionerId = readString(sessionObj?.booking?.practitionerId);
  const planKey = readString(sessionObj?.booking?.planKey);

  if (!slotId || !patientId || !practitionerId || !planKey) {
    await services.sendText({
      tenantId,
      to: phone,
      body: MSG.BOOKING_SESSION_INVALID,
      phoneNumberId,
    });
    await setState(tenantId, phone, "MAIN");
    return true;
  }

  if (upper === "ESCOLHER_OUTRO") {
    await updateSession(tenantId, phone, (sess) => {
      delete sess.pending;
      sess.booking = sess.booking || {};
      sess.booking.selectedSlotId = null;
    });

    const refreshedSession = await getSession(tenantId, phone);
    return renderSlotsAgain(flowCtx, refreshedSession);
  }

  if (upper !== "CONFIRMAR") {
    return false;
  }

  const lockKey = bookingConfirmKey(tenantId, phone, slotId);
  const lock = await redis.set(lockKey, "1", { ex: 60, nx: true });

  if (!lock) {
    await services.sendText({
      tenantId,
      to: phone,
      body: MSG.BOOKING_ALREADY_PROCESSING,
      phoneNumberId,
    });
    return true;
  }

  try {
    const bookingRequest = {
      slotId,
      patientId,
      practitionerId,
      planKey,
    };

    audit(
      "BOOKING_CONFIRM_FLOW",
      sanitizeForLog({
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        patientId,
        practitionerId,
        slotId,
        planKey,
      })
    );

    let out;
    try {
      out = await adapters.schedulingAdapter.confirmBooking({
        bookingRequest,
        runtimeCtx,
      });
    } catch (err) {
      if (isProviderTemporaryUnavailableError(err)) {
        await updateSession(tenantId, phone, (sess) => {
          delete sess.pending;
        });

        await handleProviderTemporaryUnavailable({
          tenantId,
          traceId,
          phone,
          phoneNumberId,
          capability: "booking",
          err,
          MSG,
          nextState: "MAIN",
          services,
        });
        return true;
      }
      throw err;
    }

    if (!out?.ok) {
      await updateSession(tenantId, phone, (sess) => {
        delete sess.pending;
      });

      await services.sendText({
        tenantId,
        to: phone,
        body: MSG.BOOKING_CONFIRM_FAILURE,
        phoneNumberId,
      });

      const refreshedSession = await getSession(tenantId, phone);
      return renderSlotsAgain(flowCtx, refreshedSession);
    }

    const plan = resolvePlan(runtime, sessionObj);
    const billingEnabled = plan?.rules?.billing?.enabled === true;
    const checkReturn = plan?.rules?.return?.checkEligibility === true;
    const isReturn = sessionObj?.booking?.isReturn === true;

    const showPayment =
      billingEnabled && (!checkReturn || isReturn === false);

    audit(
      "BOOKING_CONFIRMED",
      sanitizeForLog({
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        patientId,
        practitionerId,
        slotId,
        planKey,
        paymentInfoShown: showPayment,
      })
    );

    await updateSession(tenantId, phone, (sess) => {
      delete sess.pending;
    });

    await setState(tenantId, phone, "MAIN");

    await services.sendText({
      tenantId,
      to: phone,
      body: buildBookingSuccessMessage({
        MSG,
        paymentInfo: showPayment ? MSG.PAYMENT_INFO : "",
      }),
      phoneNumberId,
    });

    return true;
  } finally {
    await redis.del(lockKey).catch(() => {});
  }
}
