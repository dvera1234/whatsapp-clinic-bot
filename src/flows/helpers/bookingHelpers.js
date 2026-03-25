import { audit } from "../../observability/audit.js";
import { sanitizeForLog } from "../../utils/logSanitizer.js";
import { setState, updateSession } from "../../session/redisSession.js";
import { MIN_LEAD_HOURS, TZ_OFFSET } from "../../config/constants.js";
import { maskPhone } from "../../utils/mask.js";
import {
  handleProviderTemporaryUnavailable,
  isProviderTemporaryUnavailableError,
} from "./auditHelpers.js";
import { tpl } from "./contentHelpers.js";

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
  daysLookahead = 30, // suficiente para UX real
  limit = 3,
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
    
      // 🔴 otimização crítica
      if (dates.length >= limit) {
        break;
      }
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
  phoneNumberIdFallback,
  practitionerId,
  patientId,
  MSG,
  services,
}) {
  const result = await fetchNextAvailableDates({
    schedulingAdapter,
    runtimeCtx,
    practitionerId,
    patientId,
    phone,
    daysLookahead: 60,
    limit: 3,
  });

  if (result.providerUnavailable) {
    await handleProviderTemporaryUnavailable({
      tenantId: runtimeCtx?.tenantId,
      traceId: runtimeCtx?.traceId || null,
      phone,
      phoneNumberIdFallback,
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
      phoneNumberIdFallback,
    });
    return false;
  }

  const buttons = dates.map((iso) => ({
    id: `D_${iso}`,
    title: formatBRFromISO(iso),
  }));

  await services.sendButtons({
    tenantId: runtimeCtx?.tenantId,
    to: phone,
    body: MSG.BOOKING_PICK_DATE,
    buttons,
    phoneNumberIdFallback,
  });

  return true;
}

export async function showSlotsPage({
  tenantId,
  phone,
  phoneNumberIdFallback,
  slots,
  page = 0,
  MSG,
  services,
}) {
  const pageSize = 3;
  const start = page * pageSize;
  const end = start + pageSize;

  const pageItems = slots.slice(start, end);

  if (!pageItems.length) {
    await services.sendText({
      tenantId,
      to: phone,
      body: MSG.BOOKING_NO_SLOTS,
      phoneNumberIdFallback,
    });

    await services.sendButtons({
      tenantId,
      to: phone,
      body: MSG.BOOKING_CHANGE_DATE,
      buttons: [{ id: "TROCAR_DATA", title: MSG.BOOKING_CHANGE_DATE }],
      phoneNumberIdFallback,
    });
    return;
  }

  const buttons = pageItems.map((x) => ({
    id: `H_${x.slotId}`,
    title: x.time,
  }));

  await services.sendButtons({
    tenantId,
    to: phone,
    body: MSG.BOOKING_AVAILABLE_SLOTS,
    buttons,
    phoneNumberIdFallback,
  });

  const extraButtons = [];

  if (end < slots.length) {
    extraButtons.push({ id: `PAGE_${page + 1}`, title: MSG.BOOKING_VIEW_MORE });
  }
  extraButtons.push({ id: "TROCAR_DATA", title: MSG.BOOKING_CHANGE_DATE });

  await services.sendButtons({
    tenantId,
    to: phone,
    body: MSG.BOOKING_OPTIONS,
    buttons: extraButtons,
    phoneNumberIdFallback,
  });
}

export async function finishWizardAndGoToDates({
  schedulingAdapter,
  tenantId,
  runtime,
  phone,
  phoneNumberIdFallback,
  patientId,
  planKeyFromWizard,
  traceId = null,
  practitionerId,
  MSG,
  services,
}) {
  let eligibilityResult;

  try {
    eligibilityResult = await schedulingAdapter.checkReturnEligibility({
      patientId,
      runtimeCtx: {
        tenantId,
        runtime,
        traceId,
        tracePhone: maskPhone(phone),
      },
    });
  } catch (err) {
    if (isProviderTemporaryUnavailableError(err)) {
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
      return false;
    }
    throw err;
  }

  let isReturn = null;

  if (eligibilityResult?.ok && typeof eligibilityResult?.data?.eligible === "boolean") {
    isReturn = eligibilityResult.data.eligible;
  }

    audit(
    "RETURN_ELIGIBILITY_CHECK",
    sanitizeForLog({
      tenantId,
      traceId,
      patientId,
      providerOk: !!eligibilityResult?.ok,
      eligible: isReturn,
      rid: eligibilityResult?.rid || null,
      httpStatus: eligibilityResult?.status || null,
    })
  );
  
  await updateSession(tenantId, phone, (s) => {
    s.booking = s.booking || {};
    s.booking.patientId = patientId;
    s.booking.practitionerId = practitionerId;
    
    if (typeof isReturn === "boolean") {
      s.booking.isReturn = isReturn;
    }
    // não apagar se vier null/undefined

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
    phoneNumberIdFallback,
    practitionerId,
    patientId,
    MSG,
    services,
  });

  if (shown) {
    await setState(tenantId, phone, "ASK_DATE_PICK");
  }

  return shown;
}

export function buildBookingSuccessMessage({
  MSG,
  msgOk,
  paymentInfo,
}) {
  return tpl(MSG.BOOKING_SUCCESS_MAIN, {
    msgOk,
    paymentInfo,
  });
}
