import { debugLog } from "../../../../../observability/audit.js";
import { sanitizeForLog } from "../../../../../utils/logSanitizer.js";
import { formatCPFMask } from "../../../../../utils/validators.js";
import { versatilisFetch } from "../../../../transport/versatilis/client.js";
import { getProviderRuntimeContext } from "../shared/versatilisContext.js";
import {
  parseExternalPatientIdFromAny,
  listPlanIdsFromProfile,
  validatePatientRegistrationData,
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

function sanitizePathForLog(path) {
  const raw = String(path || "");
  if (!raw) return raw;

  try {
    const fakeUrl = new URL(raw, "https://sanitizer.local");

    const sensitiveKeys = new Set([
      "cpf",
      "usercpf",
      "dtnasc",
      "datanascimento",
      "login",
      "email",
      "codusuario",
    ]);

    for (const [key] of fakeUrl.searchParams.entries()) {
      if (sensitiveKeys.has(String(key).toLowerCase())) {
        fakeUrl.searchParams.set(key, "***");
      }
    }

    return `${fakeUrl.pathname}${fakeUrl.search}`;
  } catch {
    return raw;
  }
}

function createVersatilisPatientAdapter(factoryCtx = {}) {
  async function findPatientIdByCpf({ cpf, runtimeCtx }) {
    const cpfDigits = String(cpf || "").replace(/\D+/g, "");
    if (cpfDigits.length !== 11) return null;

    const ctx = getProviderRuntimeContext(runtimeCtx, factoryCtx);
    const runtime = ctx.runtime;

    const cpfMask = formatCPFMask(cpfDigits);

    const candidates = [
      `/api/Login/CodUsuario?CPF=${encodeURIComponent(cpfDigits)}`,
      `/api/Login/CodUsuario?cpf=${encodeURIComponent(cpfDigits)}`,
      cpfMask
        ? `/api/Login/CodUsuario?CPF=${encodeURIComponent(cpfMask)}`
        : null,
      cpfMask
        ? `/api/Login/CodUsuario?cpf=${encodeURIComponent(cpfMask)}`
        : null,
    ].filter(Boolean);

    for (const path of candidates) {
      const safePath = sanitizePathForLog(path);

      const out = await versatilisFetch(path, {
        tenantId: ctx.tenantId,
        runtime,
        traceMeta: {
          tenantId: ctx.tenantId,
          traceId: ctx.traceId,
          flow: "LOOKUP_PATIENT_ID_BY_DOCUMENT",
        },
      });

      const parsed = out.ok
        ? parseExternalPatientIdFromAny(out.data)
        : null;

      debugLog(
        "VERSA_PATIENT_ID_LOOKUP",
        sanitizeForLog({
          tenantId: ctx.tenantId,
          traceId: ctx.traceId,
          path: safePath,
          httpStatus: out.status,
          parsed: parsed ? "FOUND" : "NOT_FOUND",
        })
      );

      if (parsed) {
        return {
          id: parsed,
          status: out.status,
          rid: out.rid,
        };
      }
    }

    return null;
  }

  return {
    async findPatientByDocument({ document, runtimeCtx }) {
      const found = await findPatientIdByCpf({
        cpf: document,
        runtimeCtx,
      });

      if (!found) {
        return buildResult({
          ok: false,
          status: 404,
          errorCode: "PATIENT_NOT_FOUND",
        });
      }

      const profile = await this.getPatientProfile({
        patientId: found.id,
        runtimeCtx,
      });

      return buildResult({
        ok: profile.ok,
        status: profile.status,
        rid: profile.rid,
        data: {
          patientId: found.id,
          profile: profile.data,
        },
      });
    },

    async findPatientIdByDocument({ document, runtimeCtx }) {
      const found = await findPatientIdByCpf({
        cpf: document,
        runtimeCtx,
      });

      if (!found) {
        return buildResult({
          ok: false,
          status: 404,
          errorCode: "PATIENT_ID_NOT_FOUND",
        });
      }

      return buildResult({
        ok: true,
        status: found.status,
        rid: found.rid,
        data: {
          patientId: found.id,
        },
      });
    },

    async getPatientProfile({ patientId, runtimeCtx }) {
      const ctx = getProviderRuntimeContext(runtimeCtx, factoryCtx);
      const runtime = ctx.runtime;

      const externalId = Number(patientId);

      if (!Number.isFinite(externalId)) {
        return buildResult({
          ok: false,
          status: 400,
          errorCode: "INVALID_PATIENT_ID",
        });
      }

      const path = `/api/Login/DadosUsuarioPorCodigo?CodUsuario=${encodeURIComponent(
        externalId
      )}`;

      const out = await versatilisFetch(path, {
        tenantId: ctx.tenantId,
        runtime,
        traceMeta: {
          tenantId: ctx.tenantId,
          traceId: ctx.traceId,
          flow: "GET_PATIENT_PROFILE",
        },
      });

      if (!out.ok || !out.data) {
        return buildResult({
          ok: false,
          status: out.status || 502,
          rid: out.rid,
          errorCode: "PATIENT_PROFILE_FAILED",
        });
      }

      return buildResult({
        ok: true,
        status: out.status,
        rid: out.rid,
        data: out.data,
      });
    },

    validateRegistrationData({ profile }) {
      return buildResult({
        ok: true,
        data: validatePatientRegistrationData(profile),
      });
    },

    listActivePlans({ profile }) {
      return buildResult({
        ok: true,
        data: listPlanIdsFromProfile(profile),
      });
    },
  };
}

export { createVersatilisPatientAdapter };
