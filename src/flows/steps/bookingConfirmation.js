import { getSession, setState, updateSession, redis } from "../../session/redisSession.js";
import { audit } from "../../observability/audit.js";
import { sanitizeForLog } from "../../utils/logSanitizer.js";
import { maskPhone } from "../../utils/mask.js";
import {
  bookingConfirmKey,
  buildBookingSuccessMessage,
} from "../helpers/bookingHelpers.js";
import { tpl } from "../helpers/contentHelpers.js";

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

  const s = await getSession(tenantId, phone);
  const slotId = s?.pending?.slotId;
  const patientId = s?.booking?.patientId;
  const practitionerId = s?.booking?.practitionerId;
  const planKey = s?.booking?.planKey;

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
    });

    await setState(tenantId, phone, "SLOTS");
    return true;
  }

  if (upper === "CONFIRMAR") {
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

      const out = await adapters.schedulingAdapter.confirmBooking({
        bookingRequest,
        runtimeCtx,
      });

      if (!out.ok) {
        await services.sendText({
          tenantId,
          to: phone,
          body: MSG.BOOKING_CONFIRM_FAILURE,
          phoneNumberId,
        });
        return true;
      }

      const plan = runtime.content.plans.find(
        (p) => String(p.key) === String(planKey)
      );

      const billingEnabled = !!plan?.rules?.billing?.enabled;
      const checkReturn = !!plan?.rules?.return?.checkEligibility;
      const isReturn = s?.booking?.isReturn === true;

      const showPayment =
        billingEnabled && (!checkReturn || isReturn === false);

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

  return false;
}
