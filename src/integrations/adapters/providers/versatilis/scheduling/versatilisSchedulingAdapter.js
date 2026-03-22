import { sanitizeForLog } from "../../../../../utils/logSanitizer.js";
import { versatilisFetch } from "../../../../transport/versatilis/client.js";
import { getProviderRuntimeContext } from "../shared/versatilisContext.js";

function toHHMM(hora) {
  const s = String(hora || "").trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return null;
  const hh = String(Number(m[1])).padStart(2, "0");
  return `${hh}:${m[2]}`;
}

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

function normalizeSlots(items) {
  if (!Array.isArray(items)) return [];

  return items
    .filter(
      (item) =>
        item &&
        item.PermiteConsulta === true &&
        item.CodHorario != null
    )
    .map((item) => ({
      slotId: Number(item.CodHorario),
      time: toHHMM(item.Hora),
    }))
    .filter((item) => item.slotId && item.time)
    .sort((a, b) => a.time.localeCompare(b.time));
}

function createVersatilisSchedulingAdapter(factoryCtx = {}) {
  return {
    async findSlotsByDate({
      providerId,
      patientId,
      isoDate,
      runtimeCtx,
    }) {
      const ctx = getProviderRuntimeContext(runtimeCtx, factoryCtx);

      const path =
        `/api/Agenda/Datas?CodColaborador=${encodeURIComponent(providerId)}` +
        `&CodUsuario=${encodeURIComponent(patientId)}` +
        `&DataInicial=${encodeURIComponent(isoDate)}` +
        `&DataFinal=${encodeURIComponent(isoDate)}`;

      const out = await versatilisFetch(path, {
        tenantId: ctx.tenantId,
        runtime: ctx.runtime,
        traceMeta: sanitizeForLog({
          tenantId: ctx.tenantId,
          traceId: ctx.traceId,
          flow: "FIND_SLOTS_BY_DATE",
          providerId,
          patientId,
          isoDate,
        }),
      });

      if (out.status === 404) {
        return buildResult({
          ok: true,
          status: 404,
          rid: out.rid,
          data: { slots: [] },
        });
      }

      if (!out.ok || !Array.isArray(out.data)) {
        return buildResult({
          ok: false,
          status: out.status || 502,
          rid: out.rid,
          errorCode: "SLOTS_LOOKUP_FAILED",
          data: { slots: [] },
        });
      }

      return buildResult({
        ok: true,
        status: out.status,
        rid: out.rid,
        data: {
          slots: normalizeSlots(out.data),
        },
      });
    },

    async confirmBooking({
      bookingRequest,
      runtimeCtx,
    }) {
      const ctx = getProviderRuntimeContext(runtimeCtx, factoryCtx);

      const payload = {
        CodUnidade: bookingRequest?.unitId,
        CodEspecialidade: bookingRequest?.specialtyId,
        CodPlano: bookingRequest?.planId,
        CodHorario: bookingRequest?.slotId,
        CodUsuario: bookingRequest?.patientId,
        CodColaborador: bookingRequest?.providerId,
        BitTelemedicina: !!bookingRequest?.isTelemedicine,
        Confirmada: bookingRequest?.shouldConfirm !== false,
      };

      const out = await versatilisFetch(
        "/api/Agenda/ConfirmarAgendamento",
        {
          tenantId: ctx.tenantId,
          runtime: ctx.runtime,
          method: "POST",
          jsonBody: payload,
          traceMeta: sanitizeForLog({
            tenantId: ctx.tenantId,
            traceId: ctx.traceId,
            flow: "CONFIRM_BOOKING",
          }),
        }
      );

      if (!out.ok) {
        return buildResult({
          ok: false,
          status: out.status || 502,
          rid: out.rid,
          errorCode: "BOOKING_CONFIRM_FAILED",
          data: {
            providerResult: out.data ?? null,
          },
        });
      }

      return buildResult({
        ok: true,
        status: out.status,
        rid: out.rid,
        data: {
          bookingConfirmed: true,
          providerResult: out.data ?? null,
        },
      });
    },
  };
}

export { createVersatilisSchedulingAdapter };
