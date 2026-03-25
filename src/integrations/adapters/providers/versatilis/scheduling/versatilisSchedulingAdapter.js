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

  // dd/mm/yyyy
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (br) {
    const [, dd, mm, yyyy] = br;
    return new Date(`${yyyy}-${mm}-${dd}T00:00:00-03:00`).getTime();
  }

  // yyyy-mm-dd
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (iso) {
    const [, yyyy, mm, dd] = iso;
    return new Date(`${yyyy}-${mm}-${dd}T00:00:00-03:00`).getTime();
  }

  // fallback
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
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

function isReturnFromLastAppointment(historyItems, referenceDate) {
  const referenceMs = parseHistoryDateToMs(referenceDate);
  const lastAppointmentMs = getLastAppointmentDateMs(historyItems);

  if (!Number.isFinite(referenceMs) || !Number.isFinite(lastAppointmentMs)) {
    return null;
  }

  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const diff = referenceMs - lastAppointmentMs;

  if (diff < 0) {
    return false;
  }

  return diff <= THIRTY_DAYS_MS;
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
        capability: "booking",
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
        capability: "booking",
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

    async checkReturnEligibility({ patientId, referenceDate, runtimeCtx }) {
      const ctx = getProviderRuntimeContext(runtimeCtx, factoryCtx);
      const externalPatientId = Number(patientId);
    
      if (!externalPatientId) {
        return buildResult({
          ok: false,
          status: 400,
          errorCode: "INVALID_PATIENT_ID",
        });
      }
    
      if (!String(referenceDate || "").trim()) {
        return buildResult({
          ok: false,
          status: 400,
          errorCode: "INVALID_REFERENCE_DATE",
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
          referenceDate,
        }),
      });
    
      if (!out.ok || !Array.isArray(out.data)) {
        return buildResult({
          ok: false,
          status: out.status || 502,
          rid: out.rid,
          errorCode: "RETURN_ELIGIBILITY_LOOKUP_FAILED",
        });
      }
    
      const eligible = isReturnFromLastAppointment(out.data, referenceDate);
    
      return buildResult({
        ok: true,
        status: out.status,
        rid: out.rid,
        data: {
          eligible,
          providerResult: null,
        },
      });
    },
  };
}

export { createVersatilisSchedulingAdapter };
