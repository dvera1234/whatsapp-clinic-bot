import { getSession, setState, updateSession } from "../../session/redisSession.js";
import {
  findSlotsByDate,
  showNextDates,
  showSlotsPage,
} from "../helpers/bookingHelpers.js";
import { handleProviderTemporaryUnavailable } from "../helpers/auditHelpers.js";

export async function handleSlotSelectionStep(flowCtx) {
  const {
    tenantId,
    runtimeCtx,
    traceId,
    phone,
    phoneNumberIdFallback,
    raw,
    upper,
    state,
    MSG,
    practitionerId,
    adapters,
    services,
  } = flowCtx;

  if (upper.startsWith("D_")) {
    const appointmentDate = raw.slice(2).trim();
    const s = await getSession(tenantId, phone);

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

    const out = await findSlotsByDate({
      schedulingAdapter: adapters.schedulingAdapter,
      runtimeCtx,
      practitionerId: selectedPractitionerId,
      patientId,
      appointmentDate,
      phone,
    });

    if (out.providerUnavailable) {
      await handleProviderTemporaryUnavailable({
        tenantId,
        traceId,
        phone,
        phoneNumberIdFallback,
        capability: "booking",
        err: out.error,
        MSG,
        nextState: "MAIN",
        services,
      });
      return true;
    }

    const slots = out.ok ? out.slots : [];

    await updateSession(tenantId, phone, (sess) => {
      sess.booking = {
        ...(sess.booking || {}),
        practitionerId: selectedPractitionerId,
        patientId,
        appointmentDate,
        pageIndex: 0,
        slots,
      };
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

  if (state === "ASK_DATE_PICK") {
    const s = await getSession(tenantId, phone);
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

    const shown = await showNextDates({
      schedulingAdapter: adapters.schedulingAdapter,
      runtimeCtx,
      phone,
      phoneNumberIdFallback,
      practitionerId: selectedPractitionerId,
      patientId,
      MSG,
      services,
    });

    if (shown) {
      await setState(tenantId, phone, "ASK_DATE_PICK");
    }
    return true;
  }

  if (state === "SLOTS") {
    if (upper.startsWith("PAGE_")) {
      const n = Number(raw.split("_")[1]);

      await updateSession(tenantId, phone, (sess) => {
        sess.booking = sess.booking || {};
        sess.booking.pageIndex = Number.isFinite(n) && n >= 0 ? n : 0;
      });

      const s = await getSession(tenantId, phone);
      const slots = s?.booking?.slots || [];
      const page = Number(s?.booking?.pageIndex ?? 0) || 0;

      await showSlotsPage({
        tenantId,
        phone,
        phoneNumberIdFallback,
        slots,
        page,
        MSG,
        services,
      });
      return true;
    }

    if (upper === "TROCAR_DATA") {
      const s = await getSession(tenantId, phone);
      const selectedPractitionerId = s?.booking?.practitionerId ?? practitionerId;
      const patientId = s?.booking?.patientId;

      await updateSession(tenantId, phone, (sess) => {
        if (sess?.booking) {
          sess.booking.appointmentDate = null;
          sess.booking.slots = [];
          sess.booking.pageIndex = 0;
        }
      });

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

      const shown = await showNextDates({
        schedulingAdapter: adapters.schedulingAdapter,
        runtimeCtx,
        phone,
        phoneNumberIdFallback,
        practitionerId: selectedPractitionerId,
        patientId,
        MSG,
        services,
      });

      if (shown) {
        await setState(tenantId, phone, "ASK_DATE_PICK");
      }
      return true;
    }

    if (upper.startsWith("H_")) {
      const slotId = Number(raw.split("_")[1]);
      if (!slotId || Number.isNaN(slotId)) {
        await services.sendText({
          tenantId,
          to: phone,
          body: MSG.BOOKING_SLOT_INVALID,
          phoneNumberIdFallback,
        });
        return true;
      }

      await updateSession(tenantId, phone, (s) => {
        s.pending = { slotId };
      });

      await setState(tenantId, phone, "WAIT_CONFIRM");
      await services.sendButtons({
        tenantId,
        to: phone,
        body: MSG.BOOKING_SLOT_CONFIRM,
        buttons: [
          { id: "CONFIRMAR", title: MSG.ACTION_CONFIRM },
          { id: "ESCOLHER_OUTRO", title: MSG.ACTION_PICK_OTHER },
        ],
        phoneNumberIdFallback,
      });
      return true;
    }

    {
      const s = await getSession(tenantId, phone);
      const slots = s?.booking?.slots || [];
      const page = Number(s?.booking?.pageIndex ?? 0) || 0;

      await showSlotsPage({
        tenantId,
        phone,
        phoneNumberIdFallback,
        slots,
        page,
        MSG,
        services,
      });
      return true;
    }
  }

  return false;
}
