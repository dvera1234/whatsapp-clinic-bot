import { audit, auditOutcome } from "../../../../../observability/audit.js";
import {
  mergeTraceMeta,
  versatilisFetch,
} from "../../../../transport/versatilis/client.js";

function toHHMM(hora) {
  const s = String(hora || "").trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return null;
  const hh = String(Number(m[1])).padStart(2, "0");
  return `${hh}:${m[2]}`;
}

function createVersatilisSchedulingAdapter() {
  return {
    async checkReturnEligibility({ patientId, runtimeCtx = {} }) {
      if (!patientId) return false;

      const out = await versatilisFetch(
        `/api/Agendamento/HistoricoAgendamento?codUsuario=${encodeURIComponent(
          patientId
        )}`,
        {
          tenantId: runtimeCtx?.tenantId || null,
          tenantConfig: runtimeCtx?.tenantConfig || null,
          traceMeta: mergeTraceMeta(
            {
              tenantId: runtimeCtx?.tenantId || null,
              traceId: runtimeCtx?.traceId || null,
              tracePhone: runtimeCtx?.tracePhone || null,
            },
            {
              flow: "CHECK_RETURN_ELIGIBILITY_LAST_30_DAYS",
              patientId: Number(patientId) || null,
            }
          ),
        }
      );

      if (!out.ok || !Array.isArray(out.data)) {
        audit(
          "RETURN_ELIGIBILITY_HISTORY_UNAVAILABLE",
          auditOutcome({
            tenantId: runtimeCtx?.tenantId || null,
            traceId: runtimeCtx?.traceId || null,
            tracePhone: runtimeCtx?.tracePhone || null,
            patientId: Number(patientId) || null,
            technicalAccepted: !!out?.ok,
            httpStatus: out?.status || null,
            rid: out?.rid || null,
            functionalResult: "RETURN_ELIGIBILITY_UNAVAILABLE",
            patientFacingMessage: null,
            escalationRequired: false,
          })
        );
        return false;
      }

      const now = Date.now();
      const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

      for (const appointment of out.data) {
        if (!appointment?.Data) continue;

        const parts = appointment.Data.split("/");
        if (parts.length !== 3) continue;

        const [dd, mm, yyyy] = parts;
        const dateMs = new Date(`${yyyy}-${mm}-${dd}T00:00:00-03:00`).getTime();

        if (!Number.isFinite(dateMs)) continue;

        if (now - dateMs <= THIRTY_DAYS_MS) {
          audit(
            "RETURN_ELIGIBILITY_POSITIVE_LAST_30_DAYS",
            auditOutcome({
              tenantId: runtimeCtx?.tenantId || null,
              traceId: runtimeCtx?.traceId || null,
              tracePhone: runtimeCtx?.tracePhone || null,
              patientId: Number(patientId) || null,
              technicalAccepted: true,
              functionalResult: "RETURN_ELIGIBILITY_POSITIVE",
              patientFacingMessage: null,
              escalationRequired: false,
            })
          );
          return true;
        }
      }

      audit(
        "RETURN_ELIGIBILITY_NEGATIVE_LAST_30_DAYS",
        auditOutcome({
          tenantId: runtimeCtx?.tenantId || null,
          traceId: runtimeCtx?.traceId || null,
          tracePhone: runtimeCtx?.tracePhone || null,
          patientId: Number(patientId) || null,
          technicalAccepted: true,
          functionalResult: "RETURN_ELIGIBILITY_NEGATIVE",
          patientFacingMessage: null,
          escalationRequired: false,
          historyCount: out.data.length,
        })
      );

      return false;
    },

    async findSlotsByDate({
      tenantId,
      tenantConfig,
      traceId = null,
      providerId,
      patientId,
      isoDate,
      tracePhone = null,
    }) {
      const path =
        `/api/Agenda/Datas?CodColaborador=${encodeURIComponent(providerId)}` +
        `&CodUsuario=${encodeURIComponent(patientId)}` +
        `&DataInicial=${encodeURIComponent(isoDate)}` +
        `&DataFinal=${encodeURIComponent(isoDate)}`;

      const out = await versatilisFetch(path, {
        tenantId,
        tenantConfig,
        traceMeta: {
          tenantId,
          traceId,
          flow: "FIND_SLOTS_BY_DATE",
          tracePhone,
          providerId,
          patientId,
          isoDate,
        },
      });

      if (out.status === 404) {
        return { ok: true, slots: [] };
      }

      if (!out.ok || !Array.isArray(out.data)) {
        return { ok: false, slots: [] };
      }

      const slots = out.data
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
        .filter((x) => x.slotId && x.time)
        .sort((a, b) => a.time.localeCompare(b.time));

      return { ok: true, slots };
    },

    async confirmBooking({
      tenantId,
      tenantConfig,
      bookingRequest,
      traceMeta,
    }) {
      const payload = {
        CodUnidade: bookingRequest?.unitId,
        CodEspecialidade: bookingRequest?.specialtyId,
        CodPlano: bookingRequest?.planId,
        CodHorario: bookingRequest?.slotId,
        CodUsuario: bookingRequest?.patientId,
        CodColaborador: bookingRequest?.providerId,
        BitTelemedicina: !!bookingRequest?.isTelemedicine,
        Confirmada:
          bookingRequest?.shouldConfirm !== false,
      };

      return await versatilisFetch("/api/Agenda/ConfirmarAgendamento", {
        tenantId,
        tenantConfig,
        method: "POST",
        jsonBody: payload,
        traceMeta,
      });
    },
  };
}

export { createVersatilisSchedulingAdapter };
