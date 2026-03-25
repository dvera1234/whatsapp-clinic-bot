import { getSession, setState, updateSession, redis } from "../../session/redisSession.js";
import { PLAN_KEYS } from "../../config/constants.js";
import { audit } from "../../observability/audit.js";
import { sanitizeForLog } from "../../utils/logSanitizer.js";
import { maskPhone } from "../../utils/mask.js";
import {
  bookingConfirmKey,
  buildBookingSuccessMessage,
  findSlotsByDate,
  isSlotAllowed,
  showSlotsPage,
} from "../helpers/bookingHelpers.js";
import {
  handleProviderTemporaryUnavailable,
  isProviderTemporaryUnavailableError,
} from "../helpers/auditHelpers.js";
import { tpl } from "../helpers/contentHelpers.js";

export async function handleBookingConfirmationStep(flowCtx) {
  const {
    tenantId,
    traceId,
    phone,
    phoneNumberIdFallback,
    upper,
    state,
    MSG,
    practitionerId,
    portalUrl,
    adapters,
    runtimeCtx,
    services,
  } = flowCtx;

  if (state !== "WAIT_CONFIRM") {
    return false;
  }

  if (upper === "ESCOLHER_OUTRO") {
    const s = await getSession(tenantId, phone);
    const slots = s?.booking?.slots || [];

    await updateSession(tenantId, phone, (sess) => {
      delete sess.pending;
    });

    await setState(tenantId, phone, "SLOTS");
    await showSlotsPage({
      tenantId,
      phone,
      phoneNumberIdFallback,
      slots,
      page: 0,
      MSG,
      services,
    });
    return true;
  }

  if (upper === "CONFIRMAR") {
    const s = await getSession(tenantId, phone);

  // 🔴 CORREÇÃO: calcular retorno antes de confirmar
  const returnCheck = await adapters.schedulingAdapter.checkReturnEligibility({
    patientId: s?.booking?.patientId,
    runtimeCtx,
  });
  
  let isReturnResolved = null;
  
  if (returnCheck?.ok) {
    isReturnResolved = !!returnCheck.data?.eligible;
  
    await updateSession(tenantId, phone, (sess) => {
      sess.booking = sess.booking || {};
      sess.booking.isReturn = isReturnResolved;
    });
  } else {
    audit(
      "BOOKING_RETURN_CHECK_FAILED",
      sanitizeForLog({
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        errorCode: returnCheck?.errorCode || null,
        status: returnCheck?.status || null,
      })
    );
  }
    
    const slotId = Number(s?.pending?.slotId);

    const bookingRequest = {
      slotId,
      patientId: s?.booking?.patientId,
      providerId: s?.booking?.practitionerId ?? practitionerId,
      planKey: s?.booking?.planKey || PLAN_KEYS.PRIVATE,
      isTelemedicine: false,
    };

    if (!bookingRequest.patientId) {
      await services.sendText({
        tenantId,
        to: phone,
        body: MSG.BOOKING_PATIENT_NOT_IDENTIFIED,
        phoneNumberIdFallback,
      });
      await setState(tenantId, phone, "MAIN");
      return true;
    }

    if (!slotId || Number.isNaN(slotId)) {
      const slots = s?.booking?.slots || [];

      await updateSession(tenantId, phone, (sess) => {
        delete sess.pending;
      });

      await setState(tenantId, phone, "SLOTS");
      await services.sendText({
        tenantId,
        to: phone,
        body: MSG.BOOKING_SLOT_NOT_FOUND,
        phoneNumberIdFallback,
      });

      await showSlotsPage({
        tenantId,
        phone,
        phoneNumberIdFallback,
        slots,
        page: 0,
        MSG,
        services,
      });
      return true;
    }

    const lockKey = bookingConfirmKey(tenantId, phone, slotId);
    const lockOk = await redis.set(lockKey, "1", { ex: 60, nx: true });

    if (!lockOk) {
      await services.sendText({
        tenantId,
        to: phone,
        body: MSG.BOOKING_ALREADY_PROCESSING,
        phoneNumberIdFallback,
      });
      return true;
    }

    try {
      const appointmentDate = s?.booking?.appointmentDate;
      const chosen = (s?.booking?.slots || []).find(
        (x) => Number(x.slotId) === slotId
      );

      if (
        !appointmentDate ||
        !chosen?.time ||
        !isSlotAllowed(appointmentDate, chosen.time)
      ) {
        await updateSession(tenantId, phone, (sess) => {
          delete sess.pending;
        });

        await setState(tenantId, phone, "SLOTS");
        await services.sendText({
          tenantId,
          to: phone,
          body: MSG.BOOKING_SLOT_TOO_SOON,
          phoneNumberIdFallback,
        });

        const selectedPractitionerId = s?.booking?.practitionerId ?? practitionerId;
        const patientId = s?.booking?.patientId;

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

        const outSlots = await findSlotsByDate({
          schedulingAdapter: adapters.schedulingAdapter,
          runtimeCtx,
          practitionerId: selectedPractitionerId,
          patientId,
          appointmentDate,
          phone,
        });

        if (outSlots.providerUnavailable) {
          await handleProviderTemporaryUnavailable({
            tenantId,
            traceId,
            phone,
            phoneNumberIdFallback,
            capability: "booking",
            err: outSlots.error,
            MSG,
            nextState: "MAIN",
            services,
          });
          return true;
        }

        await updateSession(tenantId, phone, (sess) => {
          sess.booking = sess.booking || {};
          sess.booking.slots = outSlots.ok ? outSlots.slots : [];
        });

        const sUpdated = await getSession(tenantId, phone);

        await showSlotsPage({
          tenantId,
          phone,
          phoneNumberIdFallback,
          slots: sUpdated?.booking?.slots || [],
          page: 0,
          MSG,
          services,
        });
        return true;
      }

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
            phoneNumberIdFallback,
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

      audit(
        "BOOKING_CONFIRM_FLOW",
        sanitizeForLog({
          tenantId,
          traceId,
          tracePhone: maskPhone(phone),
          patientId: bookingRequest.patientId || null,
          slotId: bookingRequest.slotId || null,
          planKey: bookingRequest.planKey || null,
          providerId: bookingRequest.providerId || null,
          appointmentDate: s?.booking?.appointmentDate || null,
          appointmentTime: chosen?.time || null,
          rid: out?.rid || null,
          httpStatus: out?.status || null,
          technicalAccepted: !!out?.ok,
          functionalResult: !!out?.ok
            ? "BOOKING_PRESUMED_CREATED"
            : "BOOKING_NOT_CONFIRMED",
          patientFacingMessage: !!out?.ok
            ? "BOOKING_SUCCESS_WITH_PORTAL_GUIDANCE"
            : "BOOKING_FAILURE_RETRY_OR_SUPPORT",
          escalationRequired: !out?.ok,
        })
      );

      audit(
        "BOOKING_CONFIRMED",
        sanitizeForLog({
          tenantId,
          traceId,
          tracePhone: maskPhone(phone),
      
          patientId: bookingRequest.patientId || null,
          slotId: bookingRequest.slotId || null,
          planKey: bookingRequest.planKey || null,
          providerId: bookingRequest.providerId || null,
      
          appointmentDate: s?.booking?.appointmentDate || null,
          appointmentTime: chosen?.time || null,
      
          rid: out?.rid || null,
          httpStatus: out?.status || null,
      
          technicalAccepted: !!out?.ok,
          functionalResult: !!out?.ok
            ? "BOOKING_PRESUMED_CREATED"
            : "BOOKING_NOT_CONFIRMED",
        })
      );

      if (!out.ok) {
        await updateSession(tenantId, phone, (sess) => {
          delete sess.pending;
        });

        await setState(tenantId, phone, "SLOTS");
        await services.sendText({
          tenantId,
          to: phone,
          body: MSG.BOOKING_CONFIRM_FAILURE,
          phoneNumberIdFallback,
        });

        audit(
          "BOOKING_CONFIRM_PATIENT_RESPONSE",
          sanitizeForLog({
            tenantId,
            traceId,
            tracePhone: maskPhone(phone),
            rid: out?.rid || null,
            httpStatus: out?.status || null,
            technicalAccepted: false,
            functionalResult: "BOOKING_NOT_CONFIRMED",
            patientFacingMessage: "BOOKING_FAILURE_RETRY_OR_SUPPORT",
            patientMessageSent: true,
            escalationRequired: true,
          })
        );

        const slots = s?.booking?.slots || [];
        await showSlotsPage({
          tenantId,
          phone,
          phoneNumberIdFallback,
          slots,
          page: 0,
          MSG,
          services,
        });
        return true;
      }

      const msgOk =
        out?.data?.providerResult?.Message ||
        out?.data?.providerResult?.message ||
        out?.data?.Message ||
        out?.data?.message ||
        "Agendamento confirmado com sucesso!";
      
      const isPrivateBooking =
        (s?.booking?.planKey || PLAN_KEYS.PRIVATE) === PLAN_KEYS.PRIVATE;
      
      const sAfter = await getSession(tenantId, phone);

      let isReturnBooking = null;
      
      if (typeof sAfter?.booking?.isReturn === "boolean") {
        isReturnBooking = sAfter.booking.isReturn;
      }
      
      if (isReturnBooking === null) {
        audit(
          "BOOKING_RETURN_FLAG_MISSING",
          sanitizeForLog({
            tenantId,
            traceId,
            tracePhone: maskPhone(phone),
            planKey: s?.booking?.planKey || null,
            warning: "isReturn not defined at confirmation step",
          })
        );
      }
      
      const showPaymentInfo =
        isPrivateBooking && isReturnBooking === false;
      
      if (isReturnBooking === null) {
        audit(
          "BOOKING_PAYMENT_BLOCKED_UNKNOWN_RETURN",
          sanitizeForLog({
            tenantId,
            traceId,
            tracePhone: maskPhone(phone),
            reason: "return_status_unknown",
          })
        );
      }
      
      const paymentInfo = showPaymentInfo
        ? MSG.PAYMENT_INFO_PRIVATE_FIRST_VISIT
        : "";
      
      audit(
        "BOOKING_PAYMENT_DECISION",
        sanitizeForLog({
          tenantId,
          traceId,
          tracePhone: maskPhone(phone),
          planKey: s?.booking?.planKey || null,
          isPrivateBooking,
          isReturnBooking,
          showPaymentInfo,
        })
      );

      try {
        await setState(tenantId, phone, "MAIN");

        const sentMainSuccess = await services.sendText({
          tenantId,
          to: phone,
          body: buildBookingSuccessMessage({
            MSG,
            msgOk,
            paymentInfo,
          }),
          phoneNumberIdFallback,
        });

        let sentPortalLink = false;
        if (portalUrl) {
          sentPortalLink = await services.sendText({
            tenantId,
            to: phone,
            body: tpl(MSG.PORTAL_LINK_PREFIX, { portalUrl }),
            phoneNumberIdFallback,
          });
        }

        audit(
          "BOOKING_CONFIRM_PATIENT_RESPONSE",
          sanitizeForLog({
            tenantId,
            traceId,
            tracePhone: maskPhone(phone),
            rid: out?.rid || null,
            httpStatus: out?.status || null,
            technicalAccepted: true,
            functionalResult: "BOOKING_PRESUMED_CREATED",
            patientFacingMessage: "BOOKING_SUCCESS_WITH_PORTAL_GUIDANCE",
            patientMessageMainSent: !!sentMainSuccess,
            patientMessagePortalLinkSent: !!sentPortalLink,
            escalationRequired: false,
        
            // 🔴 CRÍTICO
            planKey: s?.booking?.planKey || null,
            isReturnBooking,
            showPaymentInfo,
          })
        );
      } catch {
        audit(
          "BOOKING_POST_CONFIRM_COMMUNICATION_FAILURE",
          sanitizeForLog({
            tenantId,
            traceId,
            tracePhone: maskPhone(phone),
            rid: out?.rid || null,
            httpStatus: out?.status || null,
            technicalAccepted: true,
            functionalResult:
              "BOOKING_CREATED_BUT_COMMUNICATION_PARTIAL_FAILURE",
            patientFacingMessage: "BOOKING_SUCCESS_FALLBACK_MESSAGE",
            escalationRequired: false,
          })
        );

        await services.sendText({
          tenantId,
          to: phone,
          body: MSG.BOOKING_SUCCESS_FALLBACK,
          phoneNumberIdFallback,
        });
      }

      return true;
    } finally {
      await redis.del(lockKey).catch(() => {});
    }
  }

  await services.sendButtons({
    tenantId,
    to: phone,
    body: MSG.BUTTONS_ONLY_WARNING,
    buttons: [
      { id: "CONFIRMAR", title: MSG.ACTION_CONFIRM },
      { id: "ESCOLHER_OUTRO", title: MSG.ACTION_PICK_OTHER },
    ],
    phoneNumberIdFallback,
  });
  return true;
}
