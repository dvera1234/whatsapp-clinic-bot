import { audit, auditOutcome } from "../../../../../observability/audit.js";
import { sanitizeForLog } from "../../../../../utils/logSanitizer.js";
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

function getProviderRuntimeContext(runtimeCtx = {}, factoryCtx = {}) {
  return {
    tenantId:
      runtimeCtx?.tenantId ||
      factoryCtx?.tenantId ||
      null,
    runtime:
      runtimeCtx?.runtime ||
      runtimeCtx?.tenantRuntime ||
      factoryCtx?.runtime ||
      null,
    traceId: runtimeCtx?.traceId || null,
    tracePhone: runtimeCtx?.tracePhone || null,
  };
}

function buildSchedulingAdapterResult({
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

function parseHistoryDateToEpochMs(brDate) {
  const raw = String(brDate || "").trim();
  const parts = raw.split("/");
  if (parts.length !== 3) return null;

  const [dd, mm, yyyy] = parts;
  const dateMs = new Date(`${yyyy}-${mm}-${dd}T00:00:00-03:00`).getTime();

  return Number.isFinite(dateMs) ? dateMs : null;
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
    async checkReturnEligibility({ patientId, runtimeCtx = {} }) {
      const ctx = getProviderRuntimeContext(runtimeCtx, factoryCtx);
      const externalPatientId = Number(patientId);

      if (!Number.isFinite(externalPatientId) || externalPatientId <= 0) {
        return buildSchedulingAdapterResult({
          ok: false,
          status: 400,
          errorCode: "INVALID_PATIENT_ID",
          errorMessage: "Invalid patientId",
          data: {
            eligible: false,
          },
        });
      }

      const out = await versatilisFetch(
        `/api/Agendamento/HistoricoAgendamento?codUsuario=${encodeURIComponent(
          externalPatientId
        )}`,
        {
          tenantId: ctx.tenantId,
          runtime: ctx.runtime,
          traceMeta: sanitizeForLog(
            mergeTraceMeta(
              {
                tenantId: ctx.tenantId,
                traceId: ctx.traceId,
                tracePhone: ctx.tracePhone,
              },
              {
                flow: "CHECK_RETURN_ELIGIBILITY_LAST_30_DAYS",
                patientId: externalPatientId,
              }
            )
          ),
        }
      );

      if (!out.ok || !Array.isArray(out.data)) {
        audit(
          "RETURN_ELIGIBILITY_HISTORY_UNAVAILABLE",
          auditOutcome(
            sanitizeForLog({
              tenantId: ctx.tenantId,
              traceId: ctx.traceId,
              tracePhone: ctx.tracePhone,
              patientId: externalPatientId,
              technicalAccepted: !!out?.ok,
              httpStatus: out?.status || null,
              rid: out?.rid || null,
              functionalResult: "RETURN_ELIGIBILITY_UNAVAILABLE",
              patientFacingMessage: null,
              escalationRequired: false,
            })
          )
        );

        return buildSchedulingAdapterResult({
          ok: false,
          status: out?.status || 502,
          rid: out?.rid || null,
          errorCode: "RETURN_ELIGIBILITY_UNAVAILABLE",
          errorMessage: "Unable to determine return eligibility",
          data: {
            eligible: false,
          },
        });
      }

      const now = Date.now();
      const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

      for (const appointment of out.data) {
        const dateMs = parseHistoryDateToEpochMs(appointment?.Data);
        if (!dateMs) continue;

        if (now - dateMs <= THIRTY_DAYS_MS) {
          audit(
            "RETURN_ELIGIBILITY_POSITIVE_LAST_30_DAYS",
            auditOutcome(
              sanitizeForLog({
                tenantId: ctx.tenantId,
                traceId: ctx.traceId,
                tracePhone: ctx.tracePhone,
                patientId: externalPatientId,
                technicalAccepted: true,
                functionalResult: "RETURN_ELIGIBILITY_POSITIVE",
                patientFacingMessage: null,
                escalationRequired: false,
              })
            )
          );

          return buildSchedulingAdapterResult({
            ok: true,
            status: out.status || 200,
            rid: out.rid || null,
            data: {
              eligible: true,
            },
          });
        }
      }

      audit(
        "RETURN_ELIGIBILITY_NEGATIVE_LAST_30_DAYS",
        auditOutcome(
          sanitizeForLog({
            tenantId: ctx.tenantId,
            traceId: ctx.traceId,
            tracePhone: ctx.tracePhone,
            patientId: externalPatientId,
            technicalAccepted: true,
            functionalResult: "RETURN_ELIGIBILITY_NEGATIVE",
            patientFacingMessage: null,
            escalationRequired: false,
            historyCount: out.data.length,
          })
        )
      );

      return buildSchedulingAdapterResult({
        ok: true,
        status: out.status || 200,
        rid: out.rid || null,
        data: {
          eligible: false,
          historyCount: out.data.length,
        },
      });
    },

    async findSlotsByDate({
      tenantId,
      runtime,
      traceId = null,
      providerId,
      patientId,
      isoDate,
      tracePhone = null,
    }) {
      const resolvedTenantId = tenantId || factoryCtx?.tenantId || null;
      const resolvedRuntime = runtime || factoryCtx?.runtime || null;

      const path =
        `/api/Agenda/Datas?CodColaborador=${encodeURIComponent(providerId)}` +
        `&CodUsuario=${encodeURIComponent(patientId)}` +
        `&DataInicial=${encodeURIComponent(isoDate)}` +
        `&DataFinal=${encodeURIComponent(isoDate)}`;

      const out = await versatilisFetch(path, {
        tenantId: resolvedTenantId,
        runtime: resolvedRuntime,
        traceMeta: sanitizeForLog({
          tenantId: resolvedTenantId,
          traceId,
          flow: "FIND_SLOTS_BY_DATE",
          tracePhone,
          providerId,
          patientId,
          isoDate,
        }),
      });

      if (out.status === 404) {
        return buildSchedulingAdapterResult({
          ok: true,
          status: 404,
          rid: out.rid || null,
          data: {
            slots: [],
          },
        });
      }

      if (!out.ok || !Array.isArray(out.data)) {
        return buildSchedulingAdapterResult({
          ok: false,
          status: out.status || 502,
          rid: out.rid || null,
          errorCode: "SLOTS_LOOKUP_FAILED",
          errorMessage: "Failed to fetch slots",
          data: {
            slots: [],
          },
        });
      }

      const slots = normalizeSlots(out.data);

      return buildSchedulingAdapterResult({
        ok: true,
        status: out.status || 200,
        rid: out.rid || null,
        data: {
          slots,
        },
      });
    },

    async confirmBooking({
      tenantId,
      runtime,
      bookingRequest,
      traceMeta,
    }) {
      const resolvedTenantId = tenantId || factoryCtx?.tenantId || null;
      const resolvedRuntime = runtime || factoryCtx?.runtime || null;

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

      const out = await versatilisFetch("/api/Agenda/ConfirmarAgendamento", {
        tenantId: resolvedTenantId,
        runtime: resolvedRuntime,
        method: "POST",
        jsonBody: payload,
        traceMeta: sanitizeForLog(traceMeta || {}),
      });

      if (!out.ok) {
        return buildSchedulingAdapterResult({
          ok: false,
          status: out.status || 502,
          rid: out.rid || null,
          errorCode: "BOOKING_CONFIRM_FAILED",
          errorMessage: "Failed to confirm booking",
          data: {
            providerResult: out.data ?? null,
          },
        });
      }

      return buildSchedulingAdapterResult({
        ok: true,
        status: out.status || 200,
        rid: out.rid || null,
        data: {
          bookingConfirmed: true,
          providerResult: out.data ?? null,
        },
      });
    },
  };
}

export { createVersatilisSchedulingAdapter };
