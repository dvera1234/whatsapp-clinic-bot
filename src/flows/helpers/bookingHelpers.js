import { maskPhone } from "../../utils/mask.js";

// =========================
// LOCK
// =========================

export function bookingConfirmKey(tenantId, phone, slotId) {
  const t = String(tenantId || "").trim();
  const p = String(phone || "").replace(/\D+/g, "");
  return `booking:confirm:${t}:${p}:${slotId}`;
}

// =========================
// SLOT TIME
// =========================

export function slotEpochMs({ appointmentDate, appointmentTime, timezone }) {
  const tz = String(timezone || "-03:00");
  const d = new Date(`${appointmentDate}T${appointmentTime}:00${tz}`);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

// =========================
// SLOT VALIDATION
// =========================

export function isSlotAllowed({ appointmentDate, appointmentTime, runtime }) {
  const rules = runtime?.content?.rules?.booking || {};

  const minLeadHours = Number(rules?.minLeadHours) || 0;
  const timezone = rules?.timezone || "-03:00";

  if (!minLeadHours) return true;

  const ms = slotEpochMs({
    appointmentDate,
    appointmentTime,
    timezone,
  });

  if (!Number.isFinite(ms)) return false;

  const minMs = Date.now() + minLeadHours * 3600000;
  return ms >= minMs;
}

// =========================
// FETCH SLOTS
// =========================

export async function findSlotsByDate({
  schedulingAdapter,
  runtimeCtx,
  practitionerId,
  patientId,
  appointmentDate,
  phone,
}) {
  let out;

  try {
    out = await schedulingAdapter.findSlotsByDate({
      practitionerId,
      patientId,
      appointmentDate,
      runtimeCtx: {
        ...runtimeCtx,
        tracePhone: maskPhone(phone),
      },
    });
  } catch (err) {
    return {
      ok: false,
      providerUnavailable: true,
      error: err,
    };
  }

  if (!out?.ok || !Array.isArray(out?.data?.slots)) {
    return { ok: false, slots: [] };
  }

  const runtime = runtimeCtx?.runtime;

  const slots = out.data.slots.filter(
    (s) =>
      s &&
      Number(s.slotId) &&
      typeof s.time === "string" &&
      isSlotAllowed({
        appointmentDate,
        appointmentTime: s.time,
        runtime,
      })
  );

  return {
    ok: true,
    slots,
  };
}

// =========================
// NEXT DATES
// =========================

export async function fetchNextAvailableDates({
  schedulingAdapter,
  runtimeCtx,
  practitionerId,
  patientId,
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
    });

    if (out.providerUnavailable) {
      return {
        ok: false,
        providerUnavailable: true,
        error: out.error,
      };
    }

    if (out.ok && out.slots.length > 0) {
      dates.push(appointmentDate);
    }
  }

  return { ok: true, dates };
}

// =========================
// FORMAT
// =========================

export function formatBRFromISO(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ""));
  if (!m) return isoDate;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

// =========================
// SUCCESS MESSAGE
// =========================

export function buildBookingSuccessMessage({ template, data }) {
  return String(template || "")
    .replace(/\{\{(\w+)\}\}/g, (_, k) =>
      data?.[k] != null ? String(data[k]) : ""
    );
}
