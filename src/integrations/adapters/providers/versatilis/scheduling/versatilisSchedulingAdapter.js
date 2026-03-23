import { sanitizeForLog } from "../../../../../utils/logSanitizer.js";
import { versatilisFetch } from "../../../../transport/versatilis/client.js";
import { getProviderRuntimeContext } from "../shared/versatilisContext.js";

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

function resolvePlanExternalId(runtime, planKey) {
  const externalId =
    runtime?.planMappings?.[planKey]?.externalId != null
      ? Number(runtime.planMappings[planKey].externalId)
      : null;

  return Number.isFinite(externalId) ? externalId : null;
}

function resolveBookingDefaults(runtime) {
  const unitId =
    runtime?.bookingDefaults?.unitId != null
      ? Number(runtime.bookingDefaults.unitId)
      : null;

  const specialtyId =
    runtime?.bookingDefaults?.specialtyId != null
      ? Number(runtime.bookingDefaults.specialtyId)
      : null;

  return {
    unitId: Number.isFinite(unitId) ? unitId : null,
    specialtyId: Number.isFinite(specialtyId) ? specialtyId : null,
  };
}

function mapBookingToVersatilisPayload(bookingRequest, runtime) {
  const planId = resolvePlanExternalId(runtime, bookingRequest?.planKey);
  const { unitId, specialtyId } = resolveBookingDefaults(runtime);

  if (!planId || !unitId || !specialtyId) {
    return null;
  }

  const slotId = Number(bookingRequest?.slotId);
  const patientId = Number(bookingRequest?.patientId);
  const providerId = Number(bookingRequest?.providerId);

  if (!slotId || !patientId || !providerId) {
    return null;
  }

  return {
    CodUnidade: unitId,
    CodEspecialidade: specialtyId,
    CodPlano: planId,
    CodHorario: slotId,
    CodUsuario: patientId,
    CodColaborador: providerId,
    BitTelemedicina: !!bookingRequest?.isTelemedicine,
    Confirmada: true,
  };
}

function normalizeSlotsFromAgendaData(data) {
  if (!Array.isArray(data)) return [];

  return data
    .filter((item) => item?.PermiteConsulta && item?.CodHorario)
    .map((item) => ({
      slotId: Number(item.CodHorario),
      time: String(item.Hora || "").trim(),
    }))
    .filter((item) => item.slotId && item.time);
}

function buildReturnEligibilityWindow() {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - 30);

  const toIso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;

  return {
    startDate: toIso(start),
    endDate: toIso(end),
  };
}

function extractReturnEligibilityFromPayload(payload) {
  if (!payload) return null;

  const directFlags = [
    payload?.eligible,
    payload?.Elegivel,
    payload?.retornoElegivel,
    payload?.RetornoElegivel,
    payload?.isReturnEligible,
    payload?.IsReturnEligible,
  ];

  for (const value of directFlags) {
    if (typeof value === "boolean") {
      return value;
    }
  }

  const counters = [
    payload?.count,
    payload?.Count,
    payload?.total,
    payload?.Total,
    payload?.quantidade,
    payload?.Quantidade,
  ];

  for (const value of counters) {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n > 0;
    }
  }

  const arrays = [
    payload?.data,
    payload?.Data,
    payload?.items,
    payload?.Items,
    payload?.agendamentos,
    payload?.Agendamentos,
    payload?.consultas,
    payload?.Consultas,
  ];

  for (const value of arrays) {
    if (Array.isArray(value)) {
      return value.length > 0;
    }
  }

  if (Array.isArray(payload)) {
    return payload.length > 0;
  }

  return null;
}

function resolveReturnEligibilityPath(patientId, runtime) {
  const template =
    runtime?.integrations?.booking?.returnEligibilityPathTemplate || null;

  if (!template || typeof template !== "string") {
    return null;
  }

  const { startDate, endDate } = buildReturnEligibilityWindow();

  return template
    .replaceAll("{patientId}", encodeURIComponent(String(patientId)))
    .replaceAll("{startDate}", encodeURIComponent(startDate))
    .replaceAll("{endDate}", encodeURIComponent(endDate));
}

function createVersatilisSchedulingAdapter(factoryCtx = {}) {
  return {
    async findSlotsByDate({ providerId, patientId, isoDate, runtimeCtx }) {
      const ctx = getProviderRuntimeContext(runtimeCtx, factoryCtx);

      const externalProviderId = Number(providerId);
      const externalPatientId = Number(patientId);
      const appointmentDate = String(isoDate || "").trim();

      if (!externalProviderId || !externalPatientId || !appointmentDate) {
        return buildResult({
          ok: false,
          status: 400,
          errorCode: "INVALID_FIND_SLOTS_INPUT",
        });
      }

      const path =
        `/api/Agenda/Datas?CodColaborador=${encodeURIComponent(
          externalProviderId
        )}` +
        `&CodUsuario=${encodeURIComponent(externalPatientId)}` +
        `&DataInicial=${encodeURIComponent(appointmentDate)}` +
        `&DataFinal=${encodeURIComponent(appointmentDate)}`;

      const out = await versatilisFetch(path, {
        tenantId: ctx.tenantId,
        runtime: ctx.runtime,
        traceMeta: sanitizeForLog({
          tenantId: ctx.tenantId,
          traceId: ctx.traceId,
          flow: "FIND_SLOTS_BY_DATE",
        }),
      });

      if (!out.ok || !Array.isArray(out.data)) {
        return buildResult({
          ok: false,
          status: out.status || 502,
          rid: out.rid,
          errorCode: "SLOTS_LOOKUP_FAILED",
        });
      }

      const slots = normalizeSlotsFromAgendaData(out.data);

      return buildResult({
        ok: true,
        status: out.status,
        rid: out.rid,
        data: { slots },
      });
    },

    async confirmBooking({ bookingRequest, runtimeCtx }) {
      const ctx = getProviderRuntimeContext(runtimeCtx, factoryCtx);

      const payload = mapBookingToVersatilisPayload(
        bookingRequest,
        ctx.runtime
      );

      if (!payload) {
        return buildResult({
          ok: false,
          status: 400,
          errorCode: "INVALID_BOOKING_MAPPING",
        });
      }

      const out = await versatilisFetch("/api/Agenda/ConfirmarAgendamento", {
        tenantId: ctx.tenantId,
        runtime: ctx.runtime,
        method: "POST",
        jsonBody: payload,
        traceMeta: sanitizeForLog({
          tenantId: ctx.tenantId,
          traceId: ctx.traceId,
          flow: "CONFIRM_BOOKING",
        }),
      });

      if (!out.ok) {
        return buildResult({
          ok: false,
          status: out.status || 502,
          rid: out.rid,
          errorCode: "BOOKING_CONFIRM_FAILED",
        });
      }

      return buildResult({
        ok: true,
        status: out.status,
        rid: out.rid,
        data: {
          bookingConfirmed: true,
          providerResult: out.data || null,
        },
      });
    },

    async checkReturnEligibility({ patientId, runtimeCtx }) {
      const ctx = getProviderRuntimeContext(runtimeCtx, factoryCtx);
      const externalPatientId = Number(patientId);

      if (!externalPatientId) {
        return buildResult({
          ok: false,
          status: 400,
          errorCode: "INVALID_PATIENT_ID",
        });
      }

      const path = resolveReturnEligibilityPath(externalPatientId, ctx.runtime);

      if (!path) {
        return buildResult({
          ok: false,
          status: 500,
          errorCode: "RETURN_ELIGIBILITY_PATH_TEMPLATE_MISSING",
          errorMessage:
            "runtime.integrations.booking.returnEligibilityPathTemplate is required for checkReturnEligibility",
        });
      }

      const out = await versatilisFetch(path, {
        tenantId: ctx.tenantId,
        runtime: ctx.runtime,
        traceMeta: sanitizeForLog({
          tenantId: ctx.tenantId,
          traceId: ctx.traceId,
          flow: "CHECK_RETURN_ELIGIBILITY",
        }),
      });

      if (!out.ok) {
        return buildResult({
          ok: false,
          status: out.status || 502,
          rid: out.rid,
          errorCode: "RETURN_ELIGIBILITY_LOOKUP_FAILED",
        });
      }

      const eligible = extractReturnEligibilityFromPayload(out.data);

      if (typeof eligible !== "boolean") {
        return buildResult({
          ok: false,
          status: out.status || 502,
          rid: out.rid,
          errorCode: "RETURN_ELIGIBILITY_PARSE_FAILED",
        });
      }

      return buildResult({
        ok: true,
        status: out.status,
        rid: out.rid,
        data: {
          eligible,
          providerResult: out.data,
        },
      });
    },
  };
}

export { createVersatilisSchedulingAdapter };
