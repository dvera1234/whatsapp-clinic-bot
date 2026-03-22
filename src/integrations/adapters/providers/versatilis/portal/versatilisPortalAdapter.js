import { audit, auditOutcome, debugLog } from "../../../../../observability/audit.js";
import { sanitizeForLog } from "../../../../../utils/logSanitizer.js";
import { cleanStr, isValidEmail } from "../../../../../utils/validators.js";
import {
  md5HexLegacyVersatilisOnly,
  generateTempPassword,
} from "../../../../../utils/crypto.js";
import {
  mergeTraceMeta,
  versatilisFetch,
} from "../../../../transport/versatilis/client.js";
import {
  resolvePlanIdFromPlanKey,
  composeAddressComplement,
  parseExternalPatientIdFromAny,
  validatePatientRegistrationData,
} from "../shared/versatilisMappers.js";
import { getProviderRuntimeContext } from "../shared/versatilisContext.js";

function buildResult({
  ok,
  data = null,
  status = null,
  rid = null,
  errorCode = null,
  errorMessage = null,
}) {
  return { ok: !!ok, data, status, rid, errorCode, errorMessage };
}

function isEmptyValue(value) {
  if (value == null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function createPayload(registrationData, runtime) {
  const planId = resolvePlanIdFromPlanKey(
    registrationData?.planKey,
    runtime
  );

  const passwordHash = md5HexLegacyVersatilisOnly(
    generateTempPassword(10)
  );

  return {
    Nome: registrationData?.fullName,
    CPF: registrationData?.document,
    Email: registrationData?.email,
    DtNasc: cleanStr(registrationData?.birthDateISO),
    Celular: registrationData?.mobilePhone,
    Telefone: registrationData?.phone || registrationData?.mobilePhone || "",
    CEP: registrationData?.postalCode,
    Endereco: registrationData?.streetAddress,
    Numero: registrationData?.addressNumber,
    Complemento: composeAddressComplement(
      registrationData?.addressComplement,
      registrationData?.stateCode
    ),
    Bairro: registrationData?.district,
    Cidade: registrationData?.city,
    CodPlano: planId ? String(planId) : "",
    CodPlanos: planId ? [planId] : [],
    Senha: passwordHash,
    Sexo:
      registrationData?.gender === "M" ||
      registrationData?.gender === "F"
        ? registrationData.gender
        : undefined,
  };
}

function validatePayload(payload, planId) {
  const missing = Object.entries(payload)
    .filter(([_, v]) => isEmptyValue(v))
    .map(([k]) => k);

  const errors = [];

  if (!cleanStr(payload.Nome) || payload.Nome.length < 5) errors.push("Nome");
  if (!/^\d{11}$/.test(String(payload.CPF).replace(/\D+/g, ""))) errors.push("CPF");
  if (!isValidEmail(payload.Email)) errors.push("Email");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.DtNasc)) errors.push("DtNasc");
  if (!/^\d{8}$/.test(String(payload.CEP).replace(/\D+/g, ""))) errors.push("CEP");
  if (!cleanStr(payload.Endereco)) errors.push("Endereco");
  if (!cleanStr(payload.Numero)) errors.push("Numero");
  if (!cleanStr(payload.Bairro)) errors.push("Bairro");
  if (!cleanStr(payload.Cidade)) errors.push("Cidade");
  if (!cleanStr(payload.Celular)) errors.push("Celular");
  if (!cleanStr(payload.Senha)) errors.push("Senha");
  if (!planId) errors.push("CodPlano");

  return { missing, errors };
}

function createVersatilisPortalAdapter(factoryCtx = {}) {
  return {
    validateRegistrationData({ profile }) {
      return buildResult({
        ok: true,
        data: validatePatientRegistrationData(profile),
      });
    },

    async createPatientRegistration({
      registrationData,
      traceMeta = {},
      runtimeCtx,
    }) {
      const ctx = getProviderRuntimeContext(runtimeCtx, factoryCtx);

      const planId = resolvePlanIdFromPlanKey(
        registrationData?.planKey,
        ctx.runtime
      );

      const payload = createPayload(registrationData, ctx.runtime);

      const { missing, errors } = validatePayload(payload, planId);

      if (missing.length || errors.length) {
        return buildResult({
          ok: false,
          status: 400,
          errorCode: "INVALID_REGISTRATION_PAYLOAD",
          data: { missing, errors },
        });
      }

      const out = await versatilisFetch("/api/Login/CadastrarUsuario", {
        tenantId: ctx.tenantId,
        runtime: ctx.runtime,
        method: "POST",
        jsonBody: payload,
        traceMeta: mergeTraceMeta(traceMeta, {
          tenantId: ctx.tenantId,
          traceId: ctx.traceId,
          flow: "CREATE_PATIENT_REGISTRATION",
        }),
      });

      if (!out.ok) {
        return buildResult({
          ok: false,
          status: out.status || 500,
          rid: out.rid,
          errorCode: "PATIENT_REGISTRATION_FAILED",
        });
      }

      const patientId =
        parseExternalPatientIdFromAny(out.data) ||
        Number(out?.data?.CodUsuario ?? out?.data?.codUsuario);

      return buildResult({
        ok: true,
        status: out.status,
        rid: out.rid,
        data: {
          patientId: Number.isFinite(Number(patientId))
            ? Number(patientId)
            : null,
        },
      });
    },
  };
}

export { createVersatilisPortalAdapter };
