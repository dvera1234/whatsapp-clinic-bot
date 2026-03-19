import { isDebugVersaShapeEnabled } from "../../../../../config/env.js";
import { debugLog } from "../../../../../observability/audit.js";
import { formatCPFMask } from "../../../../../utils/validators.js";
import { versatilisFetch } from "../../../../transport/versatilis/client.js";
import { getProviderRuntimeContext } from "../shared/versatilisContext.js";
import {
  parseExternalPatientIdFromAny,
  listPlanIdsFromProfile,
  hasPlanByDomainKey,
  validatePatientRegistrationData,
} from "../shared/versatilisMappers.js";

function createVersatilisPatientAdapter() {
  async function findPatientIdByCpf({ cpf, runtimeCtx = {} }) {
    const cpfDigits = String(cpf || "").replace(/\D+/g, "");
    if (cpfDigits.length !== 11) return null;

    const ctx = getProviderRuntimeContext(runtimeCtx);
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
      const out = await versatilisFetch(path, {
        tenantId: ctx.tenantId,
        tenantConfig: ctx.tenantConfig,
        traceMeta: {
          tenantId: ctx.tenantId,
          traceId: ctx.traceId,
          flow: "LOOKUP_PATIENT_ID_BY_DOCUMENT",
        },
      });

      if (
        isDebugVersaShapeEnabled() &&
        out.ok &&
        out.data &&
        typeof out.data === "object"
      ) {
        const keys = Object.keys(out.data || {}).slice(0, 30);

        debugLog("VERSA_PATIENT_ID_SHAPE", {
          tenantId: ctx.tenantId,
          path,
          keys,
          isArray: Array.isArray(out.data),
        });
      }

      const parsed = out.ok ? parseExternalPatientIdFromAny(out.data) : null;

      debugLog("VERSA_PATIENT_ID_LOOKUP_ATTEMPT", {
        tenantId: ctx.tenantId,
        technicalAccepted: out.ok,
        httpStatus: out.status,
        path,
        parsedResult: parsed ? "FOUND" : "NOT_FOUND",
      });

      if (!parsed) {
        debugLog("VERSA_PATIENT_ID_LOOKUP_DETAIL", {
          tenantId: ctx.tenantId,
          path,
          httpStatus: out.status,
          dataType: typeof out.data,
          dataPreview:
            typeof out.data === "string"
              ? out.data.slice(0, 80)
              : Array.isArray(out.data)
                ? "array"
                : out.data
                  ? "object"
                  : "null",
        });
      }

      if (parsed) return parsed;
    }

    return null;
  }

  async function findPatientIdByCpfFallbackProfile({ cpf, runtimeCtx = {} }) {
    const cpfDigits = String(cpf || "").replace(/\D+/g, "");
    if (cpfDigits.length !== 11) return null;

    const ctx = getProviderRuntimeContext(runtimeCtx);
    const cpfMask = formatCPFMask(cpfDigits);

    const candidates = [
      cpfMask
        ? `/api/Login/DadosUsuarioPorCPF?UserCPF=${encodeURIComponent(cpfMask)}`
        : null,
      `/api/Login/DadosUsuarioPorCPF?UserCPF=${encodeURIComponent(cpfDigits)}`,
    ].filter(Boolean);

    for (const path of candidates) {
      const out = await versatilisFetch(path, {
        tenantId: ctx.tenantId,
        tenantConfig: ctx.tenantConfig,
        traceMeta: {
          tenantId: ctx.tenantId,
          traceId: ctx.traceId,
          flow: "LOOKUP_PATIENT_PROFILE_BY_DOCUMENT",
        },
      });

      const parsed = out.ok ? parseExternalPatientIdFromAny(out.data) : null;

      debugLog("VERSA_PROFILE_LOOKUP_ATTEMPT", {
        tenantId: ctx.tenantId,
        technicalAccepted: out.ok,
        httpStatus: out.status,
        path,
        parsedResult: parsed ? "FOUND" : "NOT_FOUND",
      });

      if (!parsed) {
        debugLog("VERSA_PROFILE_LOOKUP_DETAIL", {
          tenantId: ctx.tenantId,
          path,
          httpStatus: out.status,
          dataType: typeof out.data,
        });
      }

      if (parsed) return parsed;
    }

    return null;
  }

  return {
    async findPatientByDocument({ document, runtimeCtx = {} }) {
      const patientId = await findPatientIdByCpf({
        cpf: document,
        runtimeCtx,
      });

      if (!patientId) {
        return {
          ok: false,
          patientId: null,
          profile: null,
        };
      }

      const profileResult = await this.getPatientProfile({
        patientId,
        runtimeCtx,
      });

      return {
        ok: !!profileResult?.ok,
        patientId,
        profile: profileResult?.data || null,
      };
    },

    async findPatientIdByDocument({ document, runtimeCtx = {} }) {
      const first = await findPatientIdByCpf({
        cpf: document,
        runtimeCtx,
      });

      if (first) return first;

      return await findPatientIdByCpfFallbackProfile({
        cpf: document,
        runtimeCtx,
      });
    },

    async getPatientProfile({ patientId, runtimeCtx = {} }) {
      const ctx = getProviderRuntimeContext(runtimeCtx);
      const externalPatientId = Number(patientId);

      if (!Number.isFinite(externalPatientId) || externalPatientId <= 0) {
        return { ok: false, data: null };
      }

      const out = await versatilisFetch(
        `/api/Login/DadosUsuarioPorCodigo?CodUsuario=${encodeURIComponent(
          externalPatientId
        )}`,
        {
          tenantId: ctx.tenantId,
          tenantConfig: ctx.tenantConfig,
          traceMeta: {
            tenantId: ctx.tenantId,
            traceId: ctx.traceId,
            flow: "GET_PATIENT_PROFILE",
            patientId: externalPatientId,
          },
        }
      );

      if (!out.ok || !out.data) {
        return { ok: false, data: null };
      }

      if (isDebugVersaShapeEnabled() && typeof out.data === "object") {
        const topLevelKeys =
          !Array.isArray(out.data) && out.data
            ? Object.keys(out.data).slice(0, 50)
            : [];

        debugLog("VERSA_PATIENT_PROFILE_SHAPE", {
          tenantId: ctx.tenantId,
          traceId: ctx.traceId,
          patientId: externalPatientId,
          isArray: Array.isArray(out.data),
          topLevelKeys,
        });
      }

      return { ok: true, data: out.data };
    },

    validateRegistrationData({ profile }) {
      return validatePatientRegistrationData(profile);
    },

    listActivePlans({ profile }) {
      return listPlanIdsFromProfile(profile);
    },

    hasPlan({ planIds, planKey, runtimeCtx = {} }) {
      return hasPlanByDomainKey(planIds, planKey, runtimeCtx);
    },
  };
}

export { createVersatilisPatientAdapter };
