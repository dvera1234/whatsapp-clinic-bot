import { setState, updateSession } from "../../session/redisSession.js";
import { MIN_LEAD_HOURS, TZ_OFFSET } from "../../config/constants.js";
import { maskPhone } from "../../utils/mask.js";
import {
  handleProviderTemporaryUnavailable,
  isProviderTemporaryUnavailableError,
} from "./auditHelpers.js";
import { tpl } from "./contentHelpers.js";

const PAGE_SIZE = 4;

export function bookingConfirmKey(tenantId, phone, slotId) {
  const t = String(tenantId || "").trim();
  const p = String(phone || "").replace(/\D+/g, "");
  return `booking:confirm:${t}:${p}:${slotId}`;
}

export function slotEpochMs(appointmentDate, appointmentTime) {
  const d = new Date(`${appointmentDate}T${appointmentTime}:00${TZ_OFFSET}`);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

export function isSlotAllowed(appointmentDate, appointmentTime) {
  const ms = slotEpochMs(appointmentDate, appointmentTime);
  if (!Number.isFinite(ms)) return false;
  const minMs = Date.now() + MIN_LEAD_HOURS * 60 * 60 * 1000;
  return ms >= minMs;
}

export function formatBRFromISO(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ""));
  if (!m) return isoDate;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function buildListSections({ title, rows }) {
  return [
    {
      title,
      rows,
    },
  ];
}

export async function findSlotsByDate({
  schedulingAdapter,
  runtimeCtx,
  practitionerId,
  patientId,
  appointmentDate,
  phone = "",
}) {
  let out;

  try {
    out = await schedulingAdapter.findSlotsByDate({
      providerId: practitionerId,
      patientId,
      isoDate: appointmentDate,
      runtimeCtx: {
        ...runtimeCtx,
        tracePhone: maskPhone(phone),
      },
    });
  } catch (err) {
    if (isProviderTemporaryUnavailableError(err)) {
      return {
        ok: false,
        slots: [],
        providerUnavailable: true,
        error: err,
      };
    }
    throw err;
  }

  if (!out?.ok || !Array.isArray(out?.data?.slots)) {
    return {
      ok: false,
      slots: [],
      providerUnavailable: false,
      error: null,
    };
  }

  const slots = out.data.slots.filter(
    (x) =>
      x &&
      Number(x.slotId) &&
      typeof x.time === "string" &&
      isSlotAllowed(appointmentDate, x.time)
  );

  return {
    ok: true,
    slots,
    providerUnavailable: false,
    error: null,
  };
}

export async function fetchNextAvailableDates({
  schedulingAdapter,
  runtimeCtx,
  practitionerId,
  patientId,
  phone = "",
  daysLookahead = 60,
  limit = 20,
}) {
  const dates = [];
  const start = new Date();

  for (let i = 0; i < daysLookahead && dates.length < limit; i++) {
    const d = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + i
    );

    const appointmentDate = `${d.getFullYear()}-${String(
      d.getMonth() + 1
    ).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    const out = await findSlotsByDate({
      schedulingAdapter,
      runtimeCtx,
      practitionerId,
      patientId,
      appointmentDate,
      phone,
    });

    await new Promise((r) => setTimeout(r, 50));

    if (out.providerUnavailable) {
      return {
        ok: false,
        dates: [],
        providerUnavailable: true,
        error: out.error,
      };
    }

    if (out.ok && out.slots.length > 0) {
      dates.push(appointmentDate);
    }
  }

  return {
    ok: true,
    dates,
    providerUnavailable: false,
    error: null,
  };
}

export async function showNextDates({
  schedulingAdapter,
  runtimeCtx,
  phone,
  phoneNumberId,
  practitionerId,
  patientId,
  MSG,
  services,
  page = 0,
}) {
  const result = await fetchNextAvailableDates({
    schedulingAdapter,
    runtimeCtx,
    practitionerId,
    patientId,
    phone,
    daysLookahead: 60,
    limit: 20,
  });

  if (result.providerUnavailable) {
    await handleProviderTemporaryUnavailable({
      tenantId: runtimeCtx?.tenantId,
      traceId: runtimeCtx?.traceId || null,
      phone,
      phoneNumberId,
      capability: "booking",
      err: result.error,
      MSG,
      nextState: "MAIN",
      services,
    });
    return false;
  }

  const dates = result.dates || [];

  if (!dates.length) {
    await services.sendText({
      tenantId: runtimeCtx?.tenantId,
      to: phone,
      body: MSG.BOOKING_NO_DATES,
      phoneNumberId,
    });
    return false;
  }

  const start = page * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  const pageItems = dates.slice(start, end);

  const rows = pageItems.map((iso) => ({
    id: `DATE_${iso}`,
    title: formatBRFromISO(iso),
    description: MSG.BOOKING_DATE_ROW_DESCRIPTION || "Selecionar esta data",
  }));

  if (end < dates.length) {
    rows.push({
      id: `DATE_PAGE_${page + 1}`,
      title: MSG.BOOKING_VIEW_MORE || "Ver mais datas",
      description:
        MSG.BOOKING_VIEW_MORE_DATES_DESCRIPTION ||
        "Mostrar próximas datas disponíveis",
    });
  }

  const sent = await services.sendList({
    tenantId: runtimeCtx?.tenantId,
    to: phone,
    body: MSG.BOOKING_PICK_DATE,
    buttonText: MSG.BOOKING_PICK_DATE_BUTTON || "Ver datas",
    footerText:
      MSG.BUTTONS_ONLY_WARNING || "Use a lista para selecionar uma opção.",
    sections: buildListSections({
      title: MSG.BOOKING_DATES_SECTION_TITLE || "Datas disponíveis",
      rows,
    }),
    phoneNumberId,
  });

  return !!sent;
}

export async function showSlotsPage({
  tenantId,
  phone,
  phoneNumberId,
  slots,
  page = 0,
  MSG,
  services,
}) {
  const start = page * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  const pageItems = Array.isArray(slots) ? slots.slice(start, end) : [];

  if (!pageItems.length) {
    await services.sendText({
      tenantId,
      to: phone,
      body: MSG.BOOKING_NO_SLOTS,
      phoneNumberId,
    });

    await services.sendList({
      tenantId,
      to: phone,
      body: MSG.BOOKING_CHANGE_DATE,
      buttonText: MSG.BOOKING_OPTIONS_BUTTON || "Ver opções",
      footerText:
        MSG.BUTTONS_ONLY_WARNING || "Use a lista para selecionar uma opção.",
      sections: buildListSections({
        title: MSG.BOOKING_OPTIONS_SECTION_TITLE || "Opções",
        rows: [
          {
            id: "CHANGE_DATE",
            title: MSG.BOOKING_CHANGE_DATE || "Trocar data",
            description:
              MSG.BOOKING_CHANGE_DATE_DESCRIPTION ||
              "Selecionar outro dia disponível",
          },
        ],
      }),
      phoneNumberId,
    });
    return;
  }

  const rows = pageItems.map((x) => ({
    id: `SLOT_${x.slotId}`,
    title: x.time,
    description: MSG.BOOKING_SLOT_ROW_DESCRIPTION || "Selecionar este horário",
  }));

  if (end < slots.length) {
    rows.push({
      id: `SLOT_PAGE_${page + 1}`,
      title: MSG.BOOKING_VIEW_MORE || "Ver mais horários",
      description:
        MSG.BOOKING_VIEW_MORE_SLOTS_DESCRIPTION ||
        "Mostrar próximos horários disponíveis",
    });
  }

  rows.push({
    id: "CHANGE_DATE",
    title: MSG.BOOKING_CHANGE_DATE || "Trocar data",
    description:
      MSG.BOOKING_CHANGE_DATE_DESCRIPTION ||
      "Selecionar outro dia disponível",
  });

  await services.sendList({
    tenantId,
    to: phone,
    body: MSG.BOOKING_AVAILABLE_SLOTS,
    buttonText: MSG.BOOKING_PICK_SLOT_BUTTON || "Ver horários",
    footerText:
      MSG.BUTTONS_ONLY_WARNING || "Use a lista para selecionar uma opção.",
    sections: buildListSections({
      title: MSG.BOOKING_SLOTS_SECTION_TITLE || "Horários disponíveis",
      rows,
    }),
    phoneNumberId,
  });
}

export async function finishWizardAndGoToDates({
  schedulingAdapter,
  tenantId,
  runtime,
  phone,
  phoneNumberId,
  patientId,
  planKeyFromWizard,
  traceId = null,
  practitionerId,
  MSG,
  services,
}) {
  await updateSession(tenantId, phone, (s) => {
    s.booking = s.booking || {};
    s.booking.patientId = patientId;
    s.booking.practitionerId = practitionerId;
    s.booking.datePage = 0;
    s.booking.slotPage = 0;

    if (planKeyFromWizard) {
      s.booking.planKey = planKeyFromWizard;
    }
  });

  const shown = await showNextDates({
    schedulingAdapter,
    runtimeCtx: {
      tenantId,
      runtime,
      traceId,
      tracePhone: maskPhone(phone),
    },
    phone,
    phoneNumberId,
    practitionerId,
    patientId,
    MSG,
    services,
    page: 0,
  });

  if (shown) {
    await setState(tenantId, phone, "ASK_DATE_PICK");
  }

  return shown;
}

export function buildBookingSuccessMessage({ MSG, msgOk, paymentInfo }) {
  return tpl(MSG.BOOKING_SUCCESS_MAIN, {
    msgOk,
    paymentInfo,
  });
}
