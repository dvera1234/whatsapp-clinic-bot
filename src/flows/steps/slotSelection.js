import { getSession, setState, updateSession } from "../../session/redisSession.js";
import { audit } from "../../observability/audit.js";
import { sanitizeForLog } from "../../utils/logSanitizer.js";
import { maskPhone } from "../../utils/mask.js";
import {
  findSlotsByDate,
  showNextDates,
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

function buildRuntimeCtx({ tenantId, runtime, traceId, phone }) {
  return {
    tenantId,
    runtime,
    traceId,
    tracePhone: maskPhone(phone),
  };
}

function resolvePatientId(sessionObj) {
  return readNumber(sessionObj?.booking?.patientId);
}

function resolvePractitionerId(flowCtx, sessionObj) {
  const sessionPractitionerId = readString(sessionObj?.booking?.practitionerId);
  if (sessionPractitionerId) return sessionPractitionerId;

  const selectedPractitionerId = readString(flowCtx?.selectedPractitionerId);
  if (selectedPractitionerId) return selectedPractitionerId;

  return "";
}

function parseDatePage(raw) {
  const match = /^DATE_PAGE_(\d+)$/.exec(readString(raw));
  return match ? Number(match[1]) : null;
}

function parseSlotPage(raw) {
  const match = /^SLOT_PAGE_(\d+)$/.exec(readString(raw));
  return match ? Number(match[1]) : null;
}

function parseAppointmentDate(raw) {
  const match = /^DATE_(\d{4}-\d{2}-\d{2})$/.exec(readString(raw));
  return match ? match[1] : "";
}

function parseSlotId(raw) {
  const match = /^SLOT_(\d+)$/.exec(readString(raw));
  return match ? Number(match[1]) : null;
}

async function renderDates({
  flowCtx,
  patientId,
  practitionerId,
  page,
}) {
  const {
    tenantId,
    traceId,
    phone,
    phoneNumberId,
    runtime,
    MSG,
    services,
    adapters,
  } = flowCtx;

  const shown = await showNextDates({
    schedulingAdapter: adapters.schedulingAdapter,
    runtimeCtx: buildRuntimeCtx({ tenantId, runtime, traceId, phone }),
    phone,
    phoneNumberId,
    practitionerId,
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

async function renderSlots({
  flowCtx,
  slots,
  page,
}) {
  const { tenantId, phone, phoneNumberId, MSG, services } = flowCtx;

  await showSlotsPage({
    tenantId,
    phone,
    phoneNumberId,
    slots: Array.isArray(slots) ? slots : [],
    page,
    MSG,
    services,
  });

  return true;
}

export async function handleSlotSelectionStep(flowCtx) {
  const {
    tenantId,
    traceId,
    phone,
    phoneNumberId,
    raw,
    state,
    MSG,
    adapters,
    runtime,
    services,
  } = flowCtx;

  if (state !== "ASK_DATE_PICK" && state !== "SLOTS") {
    return false;
  }

  const schedulingAdapter = adapters?.schedulingAdapter;
  const sessionObj = await getSession(tenantId, phone);
  const patientId = resolvePatientId(sessionObj);
  const practitionerId = resolvePractitionerId(flowCtx, sessionObj);

  if (!patientId || !practitionerId || !schedulingAdapter) {
    await services.sendText({
      tenantId,
      to: phone,
      body: MSG.BOOKING_SESSION_INVALID,
      phoneNumberId,
    });
    await setState(tenantId, phone, "MAIN");
    return true;
  }

  if (readString(raw) === "CHANGE_DATE") {
    await updateSession(tenantId, phone, (sess) => {
      sess.booking = sess.booking || {};
      sess.booking.datePage = 0;
      sess.booking.slotPage = 0;
      sess.booking.slots = [];
      sess.booking.selectedSlotId = null;
      delete sess.pending;
    });

    audit(
      "BOOKING_DATE_CHANGE_REQUESTED",
      sanitizeForLog({
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        patientId,
        practitionerId,
      })
    );

    return renderDates({
      flowCtx,
      patientId,
      practitionerId,
      page: 0,
    });
  }

  const requestedDatePage = parseDatePage(raw);
  if (requestedDatePage !== null) {
    await updateSession(tenantId, phone, (sess) => {
      sess.booking = sess.booking || {};
      sess.booking.datePage = requestedDatePage;
    });

    return renderDates({
      flowCtx,
      patientId,
      practitionerId,
      page: requestedDatePage,
    });
  }

  const appointmentDate = parseAppointmentDate(raw);
  if (appointmentDate) {
    audit(
      "BOOKING_DATE_SELECTED",
      sanitizeForLog({
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        patientId,
        practitionerId,
        appointmentDate,
      })
    );

    let outSlots;
    try {
      outSlots = await findSlotsByDate({
        schedulingAdapter,
        runtimeCtx: buildRuntimeCtx({ tenantId, runtime, traceId, phone }),
        practitionerId,
        patientId,
        appointmentDate,
        phone,
      });
    } catch (err) {
      if (isProviderTemporaryUnavailableError(err)) {
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

    if (outSlots?.providerUnavailable) {
      await handleProviderTemporaryUnavailable({
        tenantId,
        traceId,
        phone,
        phoneNumberId,
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
      sess.booking.selectedSlotId = null;
      sess.booking.slots = outSlots?.ok ? outSlots.slots : [];
      delete sess.pending;
    });

    await setState(tenantId, phone, "SLOTS");

    const updatedSession = await getSession(tenantId, phone);

    return renderSlots({
      flowCtx,
      slots: updatedSession?.booking?.slots || [],
      page: 0,
    });
  }

  const requestedSlotPage = parseSlotPage(raw);
  if (requestedSlotPage !== null) {
    await updateSession(tenantId, phone, (sess) => {
      sess.booking = sess.booking || {};
      sess.booking.slotPage = requestedSlotPage;
    });

    const updatedSession = await getSession(tenantId, phone);

    return renderSlots({
      flowCtx,
      slots: updatedSession?.booking?.slots || [],
      page: requestedSlotPage,
    });
  }

  const slotId = parseSlotId(raw);
  if (slotId !== null) {
    const chosen = (sessionObj?.booking?.slots || []).find(
      (item) => Number(item?.slotId) === slotId
    );

    if (!chosen) {
      await services.sendText({
        tenantId,
        to: phone,
        body: MSG.BOOKING_SLOT_NOT_FOUND,
        phoneNumberId,
      });

      if (state === "SLOTS") {
        return renderSlots({
          flowCtx,
          slots: sessionObj?.booking?.slots || [],
          page: readNumber(sessionObj?.booking?.slotPage) ?? 0,
        });
      }

      return true;
    }

    await updateSession(tenantId, phone, (sess) => {
      sess.booking = sess.booking || {};
      sess.booking.selectedSlotId = slotId;
      sess.pending = { slotId };
    });

    await setState(tenantId, phone, "WAIT_CONFIRM");

    audit(
      "BOOKING_SLOT_SELECTED",
      sanitizeForLog({
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        patientId,
        practitionerId,
        appointmentDate: sessionObj?.booking?.appointmentDate || null,
        slotId,
      })
    );

    await services.sendButtons({
      tenantId,
      to: phone,
      body: `Confirma este agendamento?\n\n📅 ${sessionObj?.booking?.appointmentDate}\n⏰ ${chosen.time}`,
      buttons: [
        { id: "CONFIRMAR", title: MSG.ACTION_CONFIRM },
        { id: "ESCOLHER_OUTRO", title: MSG.ACTION_PICK_OTHER },
      ],
      phoneNumberId,
    });

    return true;
  }

  audit(
    "BOOKING_SLOT_SELECTION_INVALID_INPUT",
    sanitizeForLog({
      tenantId,
      traceId,
      tracePhone: maskPhone(phone),
      state,
      raw: readString(raw) || null,
    })
  );

  await services.sendText({
    tenantId,
    to: phone,
    body: MSG.BUTTONS_ONLY_WARNING,
    phoneNumberId,
  });

  if (state === "ASK_DATE_PICK") {
    return renderDates({
      flowCtx,
      patientId,
      practitionerId,
      page: readNumber(sessionObj?.booking?.datePage) ?? 0,
    });
  }

  return renderSlots({
    flowCtx,
    slots: sessionObj?.booking?.slots || [],
    page: readNumber(sessionObj?.booking?.slotPage) ?? 0,
  });
}
