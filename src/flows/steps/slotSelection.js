import { getSession, setState, updateSession } from "../../session/redisSession.js";
import { audit } from "../../observability/audit.js";
import { sanitizeForLog } from "../../utils/logSanitizer.js";
import { maskPhone } from "../../utils/mask.js";
import {
  findSlotsByDate,
  showNextDates,
  showSlotsPage,
} from "../helpers/bookingHelpers.js";
import { handleProviderTemporaryUnavailable } from "../helpers/auditHelpers.js";

export async function handleSlotSelectionStep(flowCtx) {
  const {
    tenantId,
    traceId,
    phone,
    phoneNumberIdFallback,
    raw,
    state,
    MSG,
    practitionerId,
    adapters,
    runtime,
    services,
  } = flowCtx;

  const schedulingAdapter = adapters?.schedulingAdapter;

  if (state !== "ASK_DATE_PICK" && state !== "SLOTS") {
    return false;
  }

  if (raw === "CHANGE_DATE") {
    await updateSession(tenantId, phone, (sess) => {
      sess.booking = sess.booking || {};
      sess.booking.slotPage = 0;
      delete sess.pending;
    });

    audit(
      "CHANGE_DATE_REQUESTED",
      sanitizeForLog({
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
      })
    );

    const s = await getSession(tenantId, phone);
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
      schedulingAdapter,
      runtimeCtx: {
        tenantId,
        runtime,
        traceId,
        tracePhone: maskPhone(phone),
      },
      phone,
      phoneNumberIdFallback,
      practitionerId: s?.booking?.practitionerId ?? practitionerId,
      patientId,
      MSG,
      services,
      page: 0,
    });

    if (shown) {
      await setState(tenantId, phone, "ASK_DATE_PICK");
    }

    return true;
  }

  if (raw.startsWith("DATE_PAGE_")) {
    const page = Number(raw.replace("DATE_PAGE_", ""));

    if (!Number.isInteger(page) || page < 0) {
      await services.sendText({
        tenantId,
        to: phone,
        body: MSG.BUTTONS_ONLY_WARNING,
        phoneNumberIdFallback,
      });
      return true;
    }

    const s = await getSession(tenantId, phone);
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

    await updateSession(tenantId, phone, (sess) => {
      sess.booking = sess.booking || {};
      sess.booking.datePage = page;
      delete sess.pending;
    });

    audit(
      "DATES_PAGE_CHANGED",
      sanitizeForLog({
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        page,
      })
    );

    const shown = await showNextDates({
      schedulingAdapter,
      runtimeCtx: {
        tenantId,
        runtime,
        traceId,
        tracePhone: maskPhone(phone),
      },
      phone,
      phoneNumberIdFallback,
      practitionerId: s?.booking?.practitionerId ?? practitionerId,
      patientId,
      MSG,
      services,
      page,
    });

    if (shown) {
      await setState(tenantId, phone, "ASK_DATE_PICK");
    }

    return true;
  }

  if (raw.startsWith("DATE_")) {
    const appointmentDate = String(raw.replace("DATE_", "")).trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(appointmentDate)) {
      audit(
        "INVALID_DATE_SELECTION_INPUT",
        sanitizeForLog({
          tenantId,
          traceId,
          tracePhone: maskPhone(phone),
          raw,
        })
      );

      await services.sendText({
        tenantId,
        to: phone,
        body: MSG.BUTTONS_ONLY_WARNING,
        phoneNumberIdFallback,
      });
      return true;
    }

    const s = await getSession(tenantId, phone);
    const patientId = s?.booking?.patientId;
    const selectedPractitionerId = s?.booking?.practitionerId ?? practitionerId;

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

    audit(
      "DATE_SELECTED",
      sanitizeForLog({
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        appointmentDate,
      })
    );

    const outSlots = await findSlotsByDate({
      schedulingAdapter,
      runtimeCtx: {
        tenantId,
        runtime,
        traceId,
        tracePhone: maskPhone(phone),
      },
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
      sess.booking.appointmentDate = appointmentDate;
      sess.booking.selectedDate = appointmentDate;
      sess.booking.slotPage = 0;
      sess.booking.slots = outSlots.ok ? outSlots.slots : [];
      delete sess.pending;
    });

    await setState(tenantId, phone, "SLOTS");

    const updated = await getSession(tenantId, phone);

    await showSlotsPage({
      tenantId,
      phone,
      phoneNumberIdFallback,
      slots: updated?.booking?.slots || [],
      page: 0,
      MSG,
      services,
    });

    return true;
  }

  if (raw.startsWith("SLOT_PAGE_")) {
    const page = Number(raw.replace("SLOT_PAGE_", ""));

    if (!Number.isInteger(page) || page < 0) {
      await services.sendText({
        tenantId,
        to: phone,
        body: MSG.BUTTONS_ONLY_WARNING,
        phoneNumberIdFallback,
      });
      return true;
    }

    const s = await getSession(tenantId, phone);
    const slots = s?.booking?.slots || [];

    await updateSession(tenantId, phone, (sess) => {
      sess.booking = sess.booking || {};
      sess.booking.slotPage = page;
      delete sess.pending;
    });

    audit(
      "SLOTS_PAGE_CHANGED",
      sanitizeForLog({
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        page,
        slotsAvailable: Array.isArray(slots) ? slots.length : 0,
      })
    );

    await setState(tenantId, phone, "SLOTS");

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

  if (raw.startsWith("SLOT_")) {
    const slotId = Number(raw.replace("SLOT_", ""));

    if (!slotId || Number.isNaN(slotId)) {
      audit(
        "INVALID_SLOT_ID",
        sanitizeForLog({
          tenantId,
          traceId,
          tracePhone: maskPhone(phone),
          raw,
        })
      );

      await services.sendText({
        tenantId,
        to: phone,
        body: MSG.BOOKING_SLOT_NOT_FOUND,
        phoneNumberIdFallback,
      });
      return true;
    }

    const s = await getSession(tenantId, phone);
    const slots = s?.booking?.slots || [];
    const chosen = slots.find((x) => Number(x.slotId) === slotId);

    if (!chosen) {
      audit(
        "SLOT_NOT_FOUND_IN_SESSION",
        sanitizeForLog({
          tenantId,
          traceId,
          tracePhone: maskPhone(phone),
          slotId,
          slotsAvailable: Array.isArray(slots) ? slots.length : 0,
        })
      );

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
        page: s?.booking?.slotPage || 0,
        MSG,
        services,
      });

      return true;
    }

    await updateSession(tenantId, phone, (sess) => {
      sess.booking = sess.booking || {};
      sess.booking.selectedSlotId = slotId;
      sess.pending = {
        ...(sess.pending || {}),
        slotId,
      };
    });

    await setState(tenantId, phone, "WAIT_CONFIRM");

    audit(
      "SLOT_SELECTED",
      sanitizeForLog({
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        slotId,
        appointmentDate: s?.booking?.appointmentDate || null,
        appointmentTime: chosen?.time || null,
      })
    );

    await services.sendButtons({
      tenantId,
      to: phone,
      body: tplConfirmMessage({
        MSG,
        appointmentDate: s?.booking?.appointmentDate || null,
        appointmentTime: chosen?.time || null,
      }),
      buttons: [
        { id: "CONFIRMAR", title: MSG.ACTION_CONFIRM },
        { id: "ESCOLHER_OUTRO", title: MSG.ACTION_PICK_OTHER },
      ],
      phoneNumberIdFallback,
    });

    return true;
  }

  await audit(
    "INVALID_SLOT_SELECTION_INPUT",
    sanitizeForLog({
      tenantId,
      traceId,
      tracePhone: maskPhone(phone),
      raw,
      state,
    })
  );

  await services.sendText({
    tenantId,
    to: phone,
    body: MSG.BUTTONS_ONLY_WARNING,
    phoneNumberIdFallback,
  });

  if (state === "ASK_DATE_PICK") {
    const s = await getSession(tenantId, phone);
    const patientId = s?.booking?.patientId;

    if (!patientId) {
      await setState(tenantId, phone, "MAIN");
      return true;
    }

    const shown = await showNextDates({
      schedulingAdapter,
      runtimeCtx: {
        tenantId,
        runtime,
        traceId,
        tracePhone: maskPhone(phone),
      },
      phone,
      phoneNumberIdFallback,
      practitionerId: s?.booking?.practitionerId ?? practitionerId,
      patientId,
      MSG,
      services,
      page: s?.booking?.datePage || 0,
    });

    if (shown) {
      await setState(tenantId, phone, "ASK_DATE_PICK");
    }

    return true;
  }

  if (state === "SLOTS") {
    const s = await getSession(tenantId, phone);

    await showSlotsPage({
      tenantId,
      phone,
      phoneNumberIdFallback,
      slots: s?.booking?.slots || [],
      page: s?.booking?.slotPage || 0,
      MSG,
      services,
    });

    return true;
  }

  return false;
}

function tplConfirmMessage({ MSG, appointmentDate, appointmentTime }) {
  const dateText = appointmentDate
    ? String(appointmentDate).replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$3/$2/$1")
    : "";

  if (MSG.BOOKING_CONFIRM_PROMPT) {
    return String(MSG.BOOKING_CONFIRM_PROMPT)
      .replaceAll("{appointmentDate}", dateText)
      .replaceAll("{appointmentTime}", appointmentTime || "");
  }

  return `Confirma este agendamento?\n\n📅 Data: ${dateText}\n⏰ Horário: ${appointmentTime || "-"}`;
}
