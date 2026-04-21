import { sanitizeForLog } from "../../../../../utils/logSanitizer.js";
import { versatilisFetch } from "../../../../transport/versatilis/client.js";
import { getProviderRuntimeContext } from "../shared/versatilisContext.js";
import {
  resolvePlanExternalIdFromRuntime,
  resolvePlanConfigByKey,
} from "../shared/versatilisMappers.js";

function buildResult({
  ok,
  data = null,
  status = null,
  rid = null,
  errorCode = null,
  errorMessage = null,
}) {
  return {
    ok: !!ok,
    data,
    status,
    rid,
    errorCode,
    errorMessage,
  };
}

function normalizePositiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizePositiveIntList(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => normalizePositiveInt(value))
    .filter(Boolean);
}

function normalizeReturnWindowDays(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizePractitionerMode(value) {
  const mode = String(value || "").trim().toUpperCase();
  if (mode === "FIXED" || mode === "USER_SELECT" || mode === "AUTO") {
    return mode;
  }
  return null;
}

function getPlanBookingConfig(runtime, planKey) {
  const plan = resolvePlanConfigByKey(planKey, runtime);

  return {
    plan,
    practitionerMode: normalizePractitionerMode(
      plan?.booking?.practitionerMode
    ),
    practitionerIds: normalizePositiveIntList(plan?.booking?.practitionerIds),
  };
}

function resolveReturnWindowDays(runtime, planKey) {
  const plan = resolvePlanConfigByKey(planKey, runtime);

  const candidate =
    plan?.rules?.return?.windowDays ??
    plan?.rules?.returnWindowDays ??
    null;

  return normalizeReturnWindowDays(candidate);
}

function resolveAllowedPractitionerIds(runtime, planKey) {
  const { practitionerIds } = getPlanBookingConfig(runtime, planKey);
  return practitionerIds;
}

function resolvePractitionerMode(runtime, planKey) {
  const { practitionerMode } = getPlanBookingConfig(runtime, planKey);
  return practitionerMode;
}

function validatePractitionerSelection({
  runtime,
  planKey,
  practitionerId,
}) {
  const normalizedPractitionerId = normalizePositiveInt(practitionerId);
  const practitionerMode = resolvePractitionerMode(runtime, planKey);
  const allowedPractitionerIds = resolveAllowedPractitionerIds(runtime, planKey);

  if (!practitionerMode) {
    return {
      ok: false,
      errorCode: "INVALID_PRACTITIONER_MODE",
      errorMessage: "Invalid or missing practitionerMode in plan.booking",
    };
  }

  if (!normalizedPractitionerId) {
    return {
      ok: false,
      errorCode: "INVALID_PRACTITIONER_ID",
      errorMessage: "Invalid practitionerId",
    };
  }

  if (practitionerMode === "FIXED") {
    if (allowedPractitionerIds.length !== 1) {
      return {
        ok: false,
        errorCode: "INVALID_FIXED_PRACTITIONER_CONFIG",
        errorMessage:
          "FIXED practitionerMode requires exactly one practitionerId",
      };
    }

    if (normalizedPractitionerId !== allowedPractitionerIds[0]) {
      return {
        ok: false,
        errorCode: "PRACTITIONER_NOT_ALLOWED_FOR_PLAN",
        errorMessage: "Practitioner not allowed for this plan",
      };
    }

    return {
      ok: true,
      practitionerMode,
      allowedPractitionerIds,
      practitionerId: normalizedPractitionerId,
    };
  }

  if (practitionerMode === "USER_SELECT") {
    if (
      allowedPractitionerIds.length > 0 &&
      !allowedPractitionerIds.includes(normalizedPractitionerId)
    ) {
      return {
        ok: false,
        errorCode: "PRACTITIONER_NOT_ALLOWED_FOR_PLAN",
        errorMessage: "Practitioner not allowed for this plan",
      };
    }

    return {
      ok: true,
      practitionerMode,
      allowedPractitionerIds,
      practitionerId: normalizedPractitionerId,
    };
  }

  if (practitionerMode === "AUTO") {
    if (
      allowedPractitionerIds.length > 0 &&
      !allowedPractitionerIds.includes(normalizedPractitionerId)
    ) {
      return {
        ok: false,
        errorCode: "PRACTITIONER_NOT_ALLOWED_FOR_PLAN",
        errorMessage: "Practitioner not allowed for this plan",
      };
    }

    return {
      ok: true,
      practitionerMode,
      allowedPractitionerIds,
      practitionerId: normalizedPractitionerId,
    };
  }

  return {
    ok: false,
    errorCode: "INVALID_PRACTITIONER_MODE",
    errorMessage: "Unsupported practitionerMode",
  };
}

function mapBookingToVersatilisPayload(bookingRequest, runtime) {
  const planExternalId = resolvePlanExternalIdFromRuntime(
    bookingRequest?.planKey,
    runtime
  );

  const unitId = normalizePositiveInt(bookingRequest?.unitId);
  const specialtyId = normalizePositiveInt(bookingRequest?.specialtyId);
  const patientId = normalizePositiveInt(bookingRequest?.patientId);
  const slotId = normalizePositiveInt(bookingRequest?.slotId);

  const practitionerValidation = validatePractitionerSelection({
    runtime,
    planKey: bookingRequest?.planKey,
    practitionerId: bookingRequest?.practitionerId,
  });

  const missing = [];
  if (!planExternalId) missing.push("planExternalId");
  if (!unitId) missing.push("unitId");
  if (!specialtyId) missing.push("specialtyId");
  if (!patientId) missing.push("patientId");
  if (!slotId) missing.push("slotId");

  if (missing.length > 0) {
    return {
      ok: false,
      payload: null,
      missing,
      errorCode: "INVALID_BOOKING_MAPPING",
      errorMessage: `Missing booking fields: ${missing.join(", ")}`,
    };
  }

  if (!practitionerValidation.ok) {
    return {
      ok: false,
      payload: null,
      missing: [],
      errorCode: practitionerValidation.errorCode,
      errorMessage: practitionerValidation.errorMessage,
    };
  }

  return {
    ok: true,
    missing: [],
    practitionerMode: practitionerValidation.practitionerMode,
    payload: {
      CodUnidade: unitId,
      CodEspecialidade: specialtyId,
      CodPlano: planExternalId,
      CodHorario: slotId,
      CodUsuario: patientId,
      CodColaborador: practitionerValidation.practitionerId,
      BitTelemedicina: !!bookingRequest?.isTelemedicine,
      Confirmada: true,
    },
  };
}

function normalizeSlotsFromAgendaData(data) {
  if (!Array.isArray(data)) return [];

  return data
    .filter((item) => item?.PermiteConsulta && item?.CodHorario)
    .map((item) => ({
      slotId: Number(item.CodHorario),
      time: String(item.Hora || "").trim(),
      specialtyId: normalizePositiveInt(item?.CodEspecialidade),
      practitionerId: normalizePositiveInt(
        item?.CodColaborador ?? item?.CodPrestador ?? null
      ),
      unitId: normalizePositiveInt(item?.CodUnidade),
    }))
    .filter((item) => item.slotId && item.time);
}

function filterSlotsByAllowedPractitioners(slots, allowedPractitionerIds) {
  if (!Array.isArray(slots) || slots.length === 0) return [];
  if (!Array.isArray(allowedPractitionerIds) || allowedPractitionerIds.length === 0) {
    return slots;
  }

  return slots.filter((slot) =>
    allowedPractitionerIds.includes(normalizePositiveInt(slot?.practitionerId))
  );
}

function extractHistoryDate(item) {
  return (
    item?.Data ??
    item?.data ??
    item?.DataAgendamento ??
    item?.dataAgendamento ??
    item?.DataConsulta ??
    item?.dataConsulta ??
    item?.DtAgendamento ??
    item?.dtAgendamento ??
    item?.DtConsulta ??
    item?.dtConsulta ??
    item?.DataAtendimento ??
    item?.dataAtendimento ??
    null
  );
}

function parseHistoryDateToMs(rawValue) {
  if (!rawValue) return NaN;

  const raw = String(rawValue).trim();
  if (!raw) return NaN;

  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (br) {
    const [, dd, mm, yyyy] = br;
    return new Date(`${yyyy}-${mm}-${dd}T00:00:00-03:00`).getTime();
  }

  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (isoDate) {
    const [, yyyy, mm, dd] = isoDate;
    return new Date(`${yyyy}-${mm}-${dd}T00:00:00-03:00`).getTime();
  }

  const isoDateTime = /^\d{4}-\d{2}-\d{2}T/.exec(raw);
  if (isoDateTime) {
    const parsed = new Date(raw).getTime();
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  const fallback = new Date(raw).getTime();
  return Number.isFinite(fallback) ? fallback : NaN;
}

function getLastAppointmentDateMs(historyItems) {
  if (!Array.isArray(historyItems) || historyItems.length === 0) {
    return NaN;
  }

  let latestMs = NaN;

  for (const item of historyItems) {
    const dateMs = parseHistoryDateToMs(extractHistoryDate(item));
    if (!Number.isFinite(dateMs)) continue;

    if (!Number.isFinite(latestMs) || dateMs > latestMs) {
      latestMs = dateMs;
    }
  }

  return latestMs;
}

function isReturnFromLastAppointment({
  historyItems,
  referenceDate,
  windowDays,
}) {
  const referenceMs = parseHistoryDateToMs(referenceDate);
  const lastAppointmentMs = getLastAppointmentDateMs(historyItems);
  const normalizedWindowDays = normalizeReturnWindowDays(windowDays);

  if (
    !Number.isFinite(referenceMs) ||
    !Number.isFinite(lastAppointmentMs) ||
    !normalizedWindowDays
  ) {
    return null;
  }

  const diff = referenceMs - lastAppointmentMs;
  if (diff < 0) return false;

  const windowMs = normalizedWindowDays * 24 * 60 * 60 * 1000;
  return diff <= windowMs;
}

function createVersatilisSchedulingAdapter(factoryCtx = {}) {
  return {
    async findSlotsByDate({
      practitionerId,
      patientId,
      planKey,
      isoDate,
      runtimeCtx,
    }) {
      const ctx = getProviderRuntimeContext(runtimeCtx, factoryCtx);

      const externalPatientId = normalizePositiveInt(patientId);
      const appointmentDate = String(isoDate || "").trim();
      const practitionerValidation = validatePractitionerSelection({
        runtime: ctx.runtime,
        planKey,
        practitionerId,
      });

      if (!externalPatientId || !appointmentDate) {
        return buildResult({
          ok: false,
          status: 400,
          errorCode: "INVALID_FIND_SLOTS_INPUT",
          errorMessage: "Invalid patientId or isoDate",
        });
      }

      if (!practitionerValidation.ok) {
        return buildResult({
          ok: false,
          status: 400,
          errorCode: practitionerValidation.errorCode,
          errorMessage: practitionerValidation.errorMessage,
        });
      }

      const externalPractitionerId = practitionerValidation.practitionerId;

      const path =
        `/api/Agenda/Datas?CodColaborador=${encodeURIComponent(
          externalPractitionerId
        )}` +
        `&CodUsuario=${encodeURIComponent(externalPatientId)}` +
        `&DataInicial=${encodeURIComponent(appointmentDate)}` +
        `&DataFinal=${encodeURIComponent(appointmentDate)}`;

      const out = await versatilisFetch(path, {
        tenantId: ctx.tenantId,
        runtime: ctx.runtime,
        capability: "booking",
        traceMeta: sanitizeForLog({
          tenantId: ctx.tenantId,
          traceId: ctx.traceId,
          flow: "FIND_SLOTS_BY_DATE",
          planKey: planKey || null,
          practitionerMode: practitionerValidation.practitionerMode,
        }),
      });

      if (!out.ok || !Array.isArray(out.data)) {
        return buildResult({
          ok: false,
          status: out.status || 502,
          rid: out.rid,
          errorCode: "SLOTS_LOOKUP_FAILED",
          errorMessage: "Failed to load slots",
        });
      }

      const normalizedSlots = normalizeSlotsFromAgendaData(out.data);
      const filteredSlots = filterSlotsByAllowedPractitioners(
        normalizedSlots,
        practitionerValidation.allowedPractitionerIds
      );

      return buildResult({
        ok: true,
        status: out.status,
        rid: out.rid,
        data: {
          slots: filteredSlots,
          practitionerMode: practitionerValidation.practitionerMode,
        },
      });
    },

    async confirmBooking({ bookingRequest, runtimeCtx }) {
      const ctx = getProviderRuntimeContext(runtimeCtx, factoryCtx);

      const mapped = mapBookingToVersatilisPayload(bookingRequest, ctx.runtime);

      if (!mapped.ok) {
        return buildResult({
          ok: false,
          status: 400,
          errorCode: mapped.errorCode || "INVALID_BOOKING_MAPPING",
          errorMessage: mapped.errorMessage || "Invalid booking mapping",
          data: mapped.missing?.length
            ? {
                missing: mapped.missing,
              }
            : null,
        });
      }

      const out = await versatilisFetch("/api/Agenda/ConfirmarAgendamento", {
        tenantId: ctx.tenantId,
        runtime: ctx.runtime,
        capability: "booking",
        method: "POST",
        jsonBody: mapped.payload,
        traceMeta: sanitizeForLog({
          tenantId: ctx.tenantId,
          traceId: ctx.traceId,
          flow: "CONFIRM_BOOKING",
          planKey: bookingRequest?.planKey || null,
          practitionerMode: mapped.practitionerMode || null,
        }),
      });

      if (!out.ok) {
        return buildResult({
          ok: false,
          status: out.status || 502,
          rid: out.rid,
          errorCode: "BOOKING_CONFIRM_FAILED",
          errorMessage: "Failed to confirm booking",
        });
      }

      return buildResult({
        ok: true,
        status: out.status,
        rid: out.rid,
        data: {
          bookingConfirmed: true,
          providerResult: out.data || null,
          practitionerMode: mapped.practitionerMode || null,
        },
      });
    },

    async checkReturnEligibility({
      patientId,
      planKey,
      referenceDate,
      runtimeCtx,
    }) {
      const ctx = getProviderRuntimeContext(runtimeCtx, factoryCtx);
      const externalPatientId = normalizePositiveInt(patientId);
      const normalizedReferenceDate = String(referenceDate || "").trim();
      const windowDays = resolveReturnWindowDays(ctx.runtime, planKey);

      if (!externalPatientId) {
        return buildResult({
          ok: false,
          status: 400,
          errorCode: "INVALID_PATIENT_ID",
          errorMessage: "Invalid patientId",
        });
      }

      if (!normalizedReferenceDate) {
        return buildResult({
          ok: false,
          status: 400,
          errorCode: "INVALID_REFERENCE_DATE",
          errorMessage: "Invalid referenceDate",
        });
      }

      if (!windowDays) {
        return buildResult({
          ok: false,
          status: 400,
          errorCode: "INVALID_RETURN_WINDOW_DAYS",
          errorMessage: "Return windowDays not configured for plan",
        });
      }

      const path = `/api/Agendamento/HistoricoAgendamento?codUsuario=${encodeURIComponent(
        externalPatientId
      )}`;

      const out = await versatilisFetch(path, {
        tenantId: ctx.tenantId,
        runtime: ctx.runtime,
        capability: "booking",
        traceMeta: sanitizeForLog({
          tenantId: ctx.tenantId,
          traceId: ctx.traceId,
          flow: "CHECK_RETURN_ELIGIBILITY",
          referenceDate: normalizedReferenceDate,
          planKey: planKey || null,
        }),
      });

      if (!out.ok || !Array.isArray(out.data)) {
        return buildResult({
          ok: false,
          status: out.status || 502,
          rid: out.rid,
          errorCode: "RETURN_ELIGIBILITY_LOOKUP_FAILED",
          errorMessage: "Failed to load appointment history",
        });
      }

      const eligible = isReturnFromLastAppointment({
        historyItems: out.data,
        referenceDate: normalizedReferenceDate,
        windowDays,
      });

      return buildResult({
        ok: true,
        status: out.status,
        rid: out.rid,
        data: {
          eligible,
          providerResult: null,
          windowDays,
        },
      });
    },
  };
}

export { createVersatilisSchedulingAdapter };
