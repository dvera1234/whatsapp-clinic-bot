import { maskPhone } from "../../utils/mask.js";

const PRACTITIONER_MODES = new Set(["FIXED", "USER_SELECT", "AUTO"]);

// =========================
// HELPERS
// =========================

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : NaN;
}

function getBookingRules(runtime) {
  return runtime?.content?.rules?.booking || {};
}

function getRuntimePractitioners(runtime) {
  return Array.isArray(runtime?.practitioners) ? runtime.practitioners : [];
}

function getActiveRuntimePractitionerIds(runtime) {
  return getRuntimePractitioners(runtime)
    .filter((item) => item?.active !== false)
    .map((item) => readString(item?.practitionerId))
    .filter(Boolean);
}

function normalizeIdList(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [...new Set(values.map((value) => readString(value)).filter(Boolean))];
}

function assertValidPractitionerMode(practitionerMode) {
  const normalizedMode = readString(practitionerMode);

  if (!normalizedMode) {
    throw new Error("INVALID_PRACTITIONER_MODE");
  }

  if (!PRACTITIONER_MODES.has(normalizedMode)) {
    throw new Error(`INVALID_PRACTITIONER_MODE:${normalizedMode}`);
  }

  return normalizedMode;
}

function assertKnownPractitionerIds(practitionerIds, runtime) {
  const allowedIds = new Set(getActiveRuntimePractitionerIds(runtime));

  if (!allowedIds.size) {
    return practitionerIds;
  }

  for (const practitionerId of practitionerIds) {
    if (!allowedIds.has(practitionerId)) {
      throw new Error(`UNKNOWN_PRACTITIONER_ID:${practitionerId}`);
    }
  }

  return practitionerIds;
}

function resolvePractitionerScope({
  runtime,
  practitionerMode,
  practitionerId,
  practitionerIds,
}) {
  const mode = assertValidPractitionerMode(practitionerMode);

  const selectedPractitionerId = readString(practitionerId);
  const declaredPractitionerIds = normalizeIdList(practitionerIds);
  const runtimePractitionerIds = getActiveRuntimePractitionerIds(runtime);

  if (mode === "FIXED") {
    const fixedIds = declaredPractitionerIds.length
      ? declaredPractitionerIds
      : selectedPractitionerId
        ? [selectedPractitionerId]
        : [];

    if (fixedIds.length !== 1) {
      throw new Error("INVALID_FIXED_PRACTITIONER_SCOPE");
    }

    return {
      practitionerMode: mode,
      practitionerIds: assertKnownPractitionerIds(fixedIds, runtime),
    };
  }

  if (mode === "USER_SELECT") {
    if (!selectedPractitionerId) {
      throw new Error("PRACTITIONER_SELECTION_REQUIRED");
    }

    return {
      practitionerMode: mode,
      practitionerIds: assertKnownPractitionerIds(
        [selectedPractitionerId],
        runtime
      ),
    };
  }

  const autoIds = declaredPractitionerIds.length
    ? declaredPractitionerIds
    : runtimePractitionerIds;

  return {
    practitionerMode: mode,
    practitionerIds: assertKnownPractitionerIds(autoIds, runtime),
  };
}

function buildSlotMergeKey(slot) {
  return [
    readString(slot?.practitionerId),
    readString(slot?.appointmentDate),
    readString(slot?.time),
    readString(slot?.slotId),
  ].join("|");
}

function normalizeSlot(slot, practitionerId, appointmentDate) {
  if (!slot || typeof slot !== "object") {
    return null;
  }

  const slotId = readNumber(slot.slotId);
  const time = readString(slot.time);

  if (!Number.isFinite(slotId) || !time) {
    return null;
  }

  return {
    ...slot,
    slotId,
    time,
    practitionerId:
      readString(slot.practitionerId) || readString(practitionerId),
    appointmentDate:
      readString(slot.appointmentDate) || readString(appointmentDate),
  };
}

// =========================
// LOCK
// =========================

export function bookingConfirmKey(tenantId, phone, slotId) {
  const normalizedTenantId = readString(tenantId);
  const normalizedPhone = String(phone || "").replace(/\D+/g, "");
  return `booking:confirm:${normalizedTenantId}:${normalizedPhone}:${slotId}`;
}

// =========================
// SLOT TIME
// =========================

export function slotEpochMs({ appointmentDate, appointmentTime, timezone }) {
  const tz = readString(timezone) || "-03:00";
  const date = new Date(`${appointmentDate}T${appointmentTime}:00${tz}`);
  const epochMs = date.getTime();
  return Number.isFinite(epochMs) ? epochMs : NaN;
}

// =========================
// SLOT VALIDATION
// =========================

export function isSlotAllowed({ appointmentDate, appointmentTime, runtime }) {
  const rules = getBookingRules(runtime);

  const minLeadHours = Number(rules?.minLeadHours) || 0;
  const timezone = readString(rules?.timezone) || "-03:00";

  if (!minLeadHours) {
    return true;
  }

  const epochMs = slotEpochMs({
    appointmentDate,
    appointmentTime,
    timezone,
  });

  if (!Number.isFinite(epochMs)) {
    return false;
  }

  const minAllowedEpochMs = Date.now() + minLeadHours * 3600000;
  return epochMs >= minAllowedEpochMs;
}

// =========================
// FETCH SLOTS
// =========================

export async function findSlotsByDate({
  schedulingAdapter,
  runtimeCtx,
  practitionerMode,
  practitionerId,
  practitionerIds,
  patientId,
  appointmentDate,
  phone,
}) {
  const runtime = runtimeCtx?.runtime;

  const scope = resolvePractitionerScope({
    runtime,
    practitionerMode,
    practitionerId,
    practitionerIds,
  });

  if (!scope.practitionerIds.length) {
    return {
      ok: true,
      practitionerMode: scope.practitionerMode,
      slots: [],
    };
  }

  const mergedSlots = [];
  const seen = new Set();

  for (const currentPractitionerId of scope.practitionerIds) {
    let out;

    try {
      out = await schedulingAdapter.findSlotsByDate({
        practitionerId: currentPractitionerId,
        patientId,
        appointmentDate,
        runtimeCtx: {
          ...runtimeCtx,
          tracePhone: maskPhone(phone),
        },
      });
    } catch (error) {
      return {
        ok: false,
        practitionerMode: scope.practitionerMode,
        providerUnavailable: true,
        error,
      };
    }

    if (!out?.ok || !Array.isArray(out?.data?.slots)) {
      continue;
    }

    for (const rawSlot of out.data.slots) {
      const slot = normalizeSlot(
        rawSlot,
        currentPractitionerId,
        appointmentDate
      );

      if (!slot) {
        continue;
      }

      if (
        !isSlotAllowed({
          appointmentDate,
          appointmentTime: slot.time,
          runtime,
        })
      ) {
        continue;
      }

      const mergeKey = buildSlotMergeKey(slot);
      if (seen.has(mergeKey)) {
        continue;
      }

      seen.add(mergeKey);
      mergedSlots.push(slot);
    }
  }

  return {
    ok: true,
    practitionerMode: scope.practitionerMode,
    slots: mergedSlots,
  };
}

// =========================
// NEXT DATES
// =========================

export async function fetchNextAvailableDates({
  schedulingAdapter,
  runtimeCtx,
  practitionerMode,
  practitionerId,
  practitionerIds,
  patientId,
  daysLookahead = 60,
  limit = 20,
}) {
  const dates = [];
  const start = new Date();

  for (let i = 0; i < daysLookahead && dates.length < limit; i += 1) {
    const currentDate = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + i
    );

    const appointmentDate = `${currentDate.getFullYear()}-${String(
      currentDate.getMonth() + 1
    ).padStart(2, "0")}-${String(currentDate.getDate()).padStart(2, "0")}`;

    const out = await findSlotsByDate({
      schedulingAdapter,
      runtimeCtx,
      practitionerMode,
      practitionerId,
      practitionerIds,
      patientId,
      appointmentDate,
    });

    if (out.providerUnavailable) {
      return {
        ok: false,
        practitionerMode: out.practitionerMode,
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
    practitionerMode: readString(practitionerMode),
    dates,
  };
}

// =========================
// FORMAT
// =========================

export function formatBRFromISO(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ""));
  if (!match) return isoDate;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

// =========================
// SUCCESS MESSAGE
// =========================

export function buildBookingSuccessMessage({ template, data }) {
  return String(template || "").replace(/\{\{(\w+)\}\}/g, (_, key) =>
    data?.[key] != null ? String(data[key]) : ""
  );
}
