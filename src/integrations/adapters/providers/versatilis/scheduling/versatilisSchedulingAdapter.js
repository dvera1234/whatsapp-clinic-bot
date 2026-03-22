import { sanitizeForLog } from "../../../../../utils/logSanitizer.js";
import { versatilisFetch } from "../../../../transport/versatilis/client.js";
import { getProviderRuntimeContext } from "../shared/versatilisContext.js";

function buildResult({
  ok,
  data = null,
  status = null,
  rid = null,
  errorCode = null,
}) {
  return { ok: !!ok, data, status, rid, errorCode };
}

function mapBookingToVersatilisPayload(bookingRequest, runtime) {
  const planId =
    bookingRequest.planKey === "PRIVATE"
      ? runtime?.plans?.privatePlanId
      : bookingRequest.planKey === "INSURED"
      ? runtime?.plans?.insuredPlanId
      : null;

  const unitId = runtime?.clinic?.unitId;
  const specialtyId = runtime?.clinic?.specialtyId;

  if (!planId || !unitId || !specialtyId) {
    return null;
  }

  return {
    CodUnidade: unitId,
    CodEspecialidade: specialtyId,
    CodPlano: planId,
    CodHorario: bookingRequest.slotId,
    CodUsuario: bookingRequest.patientId,
    CodColaborador: bookingRequest.providerId,
    BitTelemedicina: !!bookingRequest.isTelemedicine,
    Confirmada: true,
  };
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

      const slots = out.data
        .filter((i) => i?.PermiteConsulta && i?.CodHorario)
        .map((i) => ({
          slotId: Number(i.CodHorario),
          time: i.Hora,
        }));

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
        });
      }

      return buildResult({
        ok: true,
        status: out.status,
        rid: out.rid,
        data: { bookingConfirmed: true },
      });
    },
  };
}

export { createVersatilisSchedulingAdapter };
