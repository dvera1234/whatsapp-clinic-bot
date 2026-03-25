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

// regra trazida do código antigo que estava funcionando:
// usa ag.Data em formato dd/mm/yyyy e considera retorno se houver
// qualquer histórico dentro de 30 dias.
function hasRecentValidAppointment(historyItems, now = Date.now()) {
  if (!Array.isArray(historyItems) || historyItems.length === 0) {
    return false;
  }

  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  return historyItems.some((ag) => {
    if (!ag?.Data) return false;

    const raw = String(ag.Data).trim();
    const parts = raw.split("/");
    if (parts.length !== 3) return false;

    const [dd, mm, yyyy] = parts;
    const dateMs = new Date(
      `${yyyy}-${mm}-${dd}T00:00:00-03:00`
    ).getTime();

    if (!Number.isFinite(dateMs)) return false;

    const diff = now - dateMs;
    return diff >= 0 && diff <= THIRTY_DAYS_MS;
  });
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

      const eligible = hasRecentValidAppointment(out.data);

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
