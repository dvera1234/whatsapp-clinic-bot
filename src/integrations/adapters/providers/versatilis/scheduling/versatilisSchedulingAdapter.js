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

function parsePossibleDate(rawValue) {
  if (!rawValue) return null;

  if (rawValue instanceof Date && !Number.isNaN(rawValue.getTime())) {
    return rawValue;
  }

  const raw = String(rawValue).trim();
  if (!raw) return null;

  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  const brMatch = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(
    raw
  );
  if (brMatch) {
    const [, dd, mm, yyyy, hh = "00", mi = "00", ss = "00"] = brMatch;
    const parsed = new Date(
      Number(yyyy),
      Number(mm) - 1,
      Number(dd),
      Number(hh),
      Number(mi),
      Number(ss)
    );
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return null;
}

function normalizeStatusText(item) {
  const raw =
    item?.Status ??
    item?.status ??
    item?.Situacao ??
    item?.situacao ??
    item?.DescricaoStatus ??
    item?.descricaoStatus ??
    "";

  return String(raw || "").trim().toLowerCase();
}

function isCancelledStatus(item) {
  const status = normalizeStatusText(item);

  return (
    status.includes("cancel") ||
    status.includes("cancelada") ||
    status.includes("cancelado")
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

function hasRecentValidAppointment(historyItems, now = new Date()) {
  if (!Array.isArray(historyItems)) return false;

  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  return historyItems.some((item) => {
    if (!item || isCancelledStatus(item)) {
      return false;
    }

    const parsedDate = parsePossibleDate(extractHistoryDate(item));
    if (!parsedDate) {
      return false;
    }

    const diff = now.getTime() - parsedDate.getTime();

    if (diff < 0) {
      return false;
    }

    return diff <= THIRTY_DAYS_MS;
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
