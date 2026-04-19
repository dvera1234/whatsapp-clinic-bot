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
    phoneNumberId,
    raw,
    state,
    MSG,
    adapters,
    runtime,
    services,
  } = flowCtx;

  const schedulingAdapter = adapters?.schedulingAdapter;

  if (state !== "ASK_DATE_PICK" && state !== "SLOTS") {
    return false;
  }

  const s = await getSession(tenantId, phone);
  const patientId = s?.booking?.patientId;
  const practitionerId = s?.booking?.practitionerId;

  if (!patientId || !practitionerId) {
    await services.sendText({
      tenantId,
      to: phone,
      body: MSG.BOOKING_SESSION_INVALID,
      phoneNumberId,
    });
    await setState(tenantId, phone, "MAIN");
    return true;
  }

  if (raw === "CHANGE_DATE") {
    await updateSession(tenantId, phone, (sess) => {
      sess.booking.slotPage = 0;
      delete sess.pending;
    });

    const shown = await showNextDates({
      schedulingAdapter,
      runtimeCtx: { tenantId, runtime, traceId, tracePhone: maskPhone(phone) },
      phone,
      phoneNumberId,
      practitionerId,
      patientId,
      MSG,
      services,
      page: 0,
    });

    if (shown) await setState(tenantId, phone, "ASK_DATE_PICK");
    return true;
  }

  if (raw.startsWith("DATE_")) {
    const appointmentDate = raw.replace("DATE_", "");

    const outSlots = await findSlotsByDate({
      schedulingAdapter,
      runtimeCtx: { tenantId, runtime, traceId, tracePhone: maskPhone(phone) },
      practitionerId,
      patientId,
      appointmentDate,
      phone,
    });

    if (outSlots.providerUnavailable) {
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
      sess.booking.appointmentDate = appointmentDate;
      sess.booking.slotPage = 0;
      sess.booking.slots = outSlots.ok ? outSlots.slots : [];
    });

    await setState(tenantId, phone, "SLOTS");

    const updated = await getSession(tenantId, phone);

    await showSlotsPage({
      tenantId,
      phone,
      phoneNumberId,
      slots: updated.booking.slots,
      page: 0,
      MSG,
      services,
    });

    return true;
  }

  if (raw.startsWith("SLOT_")) {
    const slotId = Number(raw.replace("SLOT_", ""));

    const chosen = (s?.booking?.slots || []).find(
      (x) => Number(x.slotId) === slotId
    );

    if (!chosen) {
      await services.sendText({
        tenantId,
        to: phone,
        body: MSG.BOOKING_SLOT_NOT_FOUND,
        phoneNumberId,
      });
      return true;
    }

    await updateSession(tenantId, phone, (sess) => {
      sess.booking.selectedSlotId = slotId;
      sess.pending = { slotId };
    });

    await setState(tenantId, phone, "WAIT_CONFIRM");

    await services.sendButtons({
      tenantId,
      to: phone,
      body: `Confirma este agendamento?\n\n📅 ${s.booking.appointmentDate}\n⏰ ${chosen.time}`,
      buttons: [
        { id: "CONFIRMAR", title: MSG.ACTION_CONFIRM },
        { id: "ESCOLHER_OUTRO", title: MSG.ACTION_PICK_OTHER },
      ],
      phoneNumberId,
    });

    return true;
  }

  return false;
}
