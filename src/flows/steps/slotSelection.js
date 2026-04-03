import { sendList } from "../../whatsapp/sender.js";
import { updateSession } from "../../session/redisSession.js";
import { audit } from "../../observability/audit.js";
import { maskPhone } from "../../utils/mask.js";

export async function slotSelection({
  context,
  phone,
  raw,
  session,
  runtimeCtx,
  schedulingAdapter,
}) {
  const { traceId } = runtimeCtx || {};

  // =========================
  // DATE SELECTION
  // =========================
  if (raw.startsWith("DATE_")) {
    const appointmentDate = raw.replace("DATE_", "");

    await updateSession(phone, {
      booking: {
        ...session.booking,
        selectedDate: appointmentDate,
        page: 0,
      },
    });

    await audit("DATE_SELECTED", {
      traceId,
      phoneMasked: maskPhone(phone),
      appointmentDate,
    });

    return context.helpers.showSlotsPage({
      context,
      phone,
      session: {
        ...session,
        booking: {
          ...session.booking,
          selectedDate: appointmentDate,
          page: 0,
        },
      },
      runtimeCtx,
      schedulingAdapter,
    });
  }

  // =========================
  // PAGINATION
  // =========================
  if (raw.startsWith("PAGE_")) {
    const page = Number(raw.replace("PAGE_", ""));

    await updateSession(phone, {
      booking: {
        ...session.booking,
        page,
      },
    });

    await audit("SLOTS_PAGE_CHANGED", {
      traceId,
      phoneMasked: maskPhone(phone),
      page,
    });

    return context.helpers.showSlotsPage({
      context,
      phone,
      session: {
        ...session,
        booking: {
          ...session.booking,
          page,
        },
      },
      runtimeCtx,
      schedulingAdapter,
    });
  }

  // =========================
  // CHANGE DATE
  // =========================
  if (raw === "CHANGE_DATE") {
    await audit("CHANGE_DATE_REQUESTED", {
      traceId,
      phoneMasked: maskPhone(phone),
    });

    return context.helpers.showNextDates({
      context,
      phone,
      runtimeCtx,
      schedulingAdapter,
      session,
    });
  }

  // =========================
  // SLOT SELECTION
  // =========================
  if (raw.startsWith("SLOT_")) {
    const slotId = Number(raw.replace("SLOT_", ""));

    if (!slotId) {
      await audit("INVALID_SLOT_ID", {
        traceId,
        phoneMasked: maskPhone(phone),
        raw,
      });

      return context.sender.sendText(
        phone,
        "❌ Horário inválido. Tente novamente."
      );
    }

    await updateSession(phone, {
      booking: {
        ...session.booking,
        selectedSlotId: slotId,
      },
    });

    await audit("SLOT_SELECTED", {
      traceId,
      phoneMasked: maskPhone(phone),
      slotId,
      appointmentDate: session.booking?.selectedDate,
    });

    return context.steps.bookingConfirmation({
      context,
      phone,
      session: {
        ...session,
        booking: {
          ...session.booking,
          selectedSlotId: slotId,
        },
      },
      runtimeCtx,
      schedulingAdapter,
    });
  }

  // =========================
  // FALLBACK (INVALID INPUT)
  // =========================
  await audit("INVALID_SLOT_SELECTION_INPUT", {
    traceId,
    phoneMasked: maskPhone(phone),
    raw,
  });

  return context.sender.sendText(
    phone,
    "❌ Opção inválida.\n\nSelecione uma opção da lista."
  );
}
