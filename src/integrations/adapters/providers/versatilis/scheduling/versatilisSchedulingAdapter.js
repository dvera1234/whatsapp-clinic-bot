import { audit, auditOutcome } from "../../../../../observability/audit.js";
import { mergeTraceMeta, versatilisFetch } from "../../../../transport/versatilis/client.js";

function toHHMM(hora) {
  const s = String(hora || "").trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return null;
  const hh = String(Number(m[1])).padStart(2, "0");
  return `${hh}:${m[2]}`;
}

function createVersatilisSchedulingAdapter() {
  return {
    async verificarRetorno30Dias({ codUsuario, runtimeCtx = {} }) {
      if (!codUsuario) return false;

      const out = await versatilisFetch(
        `/api/Agendamento/HistoricoAgendamento?codUsuario=${encodeURIComponent(
          codUsuario
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
              flow: "RETURN_CHECK_LAST_30_DAYS",
              codUsuario: Number(codUsuario) || null,
            }
          ),
        }
      );

      if (!out.ok || !Array.isArray(out.data)) {
        audit(
          "RETURN_CHECK_HISTORY_UNAVAILABLE",
          auditOutcome({
            tenantId: runtimeCtx?.tenantId || null,
            traceId: runtimeCtx?.traceId || null,
            tracePhone: runtimeCtx?.tracePhone || null,
            codUsuario: Number(codUsuario) || null,
            technicalAccepted: !!out?.ok,
            httpStatus: out?.status || null,
            rid: out?.rid || null,
            functionalResult: "RETURN_CHECK_UNAVAILABLE",
            patientFacingMessage: null,
            escalationRequired: false,
          })
        );
        return false;
      }

      const now = Date.now();
      const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

      for (const ag of out.data) {
        if (!ag?.Data) continue;

        const parts = ag.Data.split("/");
        if (parts.length !== 3) continue;

        const [dd, mm, yyyy] = parts;
        const dateMs = new Date(`${yyyy}-${mm}-${dd}T00:00:00-03:00`).getTime();

        if (!Number.isFinite(dateMs)) continue;

        if (now - dateMs <= THIRTY_DAYS_MS) {
          audit(
            "RETURN_CHECK_POSITIVE_LAST_30_DAYS",
            auditOutcome({
              tenantId: runtimeCtx?.tenantId || null,
              traceId: runtimeCtx?.traceId || null,
              tracePhone: runtimeCtx?.tracePhone || null,
              codUsuario: Number(codUsuario) || null,
              technicalAccepted: true,
              functionalResult: "RETURN_CHECK_POSITIVE",
              patientFacingMessage: null,
              escalationRequired: false,
            })
          );
          return true;
        }
      }

      audit(
        "RETURN_CHECK_NEGATIVE_LAST_30_DAYS",
        auditOutcome({
          tenantId: runtimeCtx?.tenantId || null,
          traceId: runtimeCtx?.traceId || null,
          tracePhone: runtimeCtx?.tracePhone || null,
          codUsuario: Number(codUsuario) || null,
          technicalAccepted: true,
          functionalResult: "RETURN_CHECK_NEGATIVE",
          patientFacingMessage: null,
          escalationRequired: false,
          historyCount: out.data.length,
        })
      );

      return false;
    },

    async buscarSlotsDoDia({
      tenantId,
      tenantConfig,
      traceId = null,
      codColaborador,
      codUsuario,
      isoDate,
      tracePhone = null,
    }) {
      const path =
        `/api/Agenda/Datas?CodColaborador=${encodeURIComponent(codColaborador)}` +
        `&CodUsuario=${encodeURIComponent(codUsuario)}` +
        `&DataInicial=${encodeURIComponent(isoDate)}` +
        `&DataFinal=${encodeURIComponent(isoDate)}`;

      const out = await versatilisFetch(path, {
        tenantId,
        tenantConfig,
        traceMeta: {
          tenantId,
          traceId,
          flow: "FETCH_SLOTS_DO_DIA",
          tracePhone,
          codColaborador,
          codUsuario,
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
        .filter((h) => h && h.PermiteConsulta === true && h.CodHorario != null)
        .map((h) => ({
          codHorario: Number(h.CodHorario),
          hhmm: toHHMM(h.Hora),
        }))
        .filter((x) => x.codHorario && x.hhmm)
        .sort((a, b) => a.hhmm.localeCompare(b.hhmm));

      return { ok: true, slots };
    },

    async confirmarAgendamento({
      tenantId,
      tenantConfig,
      payload,
      traceMeta,
    }) {
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
