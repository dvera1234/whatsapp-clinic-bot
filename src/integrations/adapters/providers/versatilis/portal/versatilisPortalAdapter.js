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
  return {
    ok: !!ok,
    data,
    status,
    rid,
    errorCode,
    errorMessage,
  };
}

function isEmptyValue(value) {
  if (value == null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function describeShape(value) {
  if (value == null) return "null/undefined";
  if (typeof value === "string") return `string(len=${value.length})`;
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return `array(len=${value.length})`;
  return typeof value;
}

function resolvePlanExternalId(planKey, runtime) {
  return (
    Number(
      runtime?.planMappings?.[planKey]?.externalId ||
        runtime?.integrations?.booking?.planMappings?.[planKey]?.externalId ||
        0
    ) || null
  );
}

function createPayload(registrationData, runtime) {
  const planId = resolvePlanExternalId(registrationData?.planKey, runtime);

  const passwordHash = md5HexLegacyVersatilisOnly(generateTempPassword(10));

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
      registrationData?.gender === "M" || registrationData?.gender === "F"
        ? registrationData.gender
        : undefined,
  };
}

function validatePayload(payload, planId) {
  const missing = Object.entries(payload)
    .filter(([_, value]) => isEmptyValue(value))
    .map(([key]) => key);

  const errors = [];

  if (!cleanStr(payload.Nome) || cleanStr(payload.Nome).length < 5) {
    errors.push("Nome");
  }

  if (!/^\d{11}$/.test(String(payload.CPF || "").replace(/\D+/g, ""))) {
    errors.push("CPF");
  }

  if (!isValidEmail(payload.Email)) {
    errors.push("Email");
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payload.DtNasc || ""))) {
    errors.push("DtNasc");
  }

  if (!/^\d{8}$/.test(String(payload.CEP || "").replace(/\D+/g, ""))) {
    errors.push("CEP");
  }

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

      const planId = resolvePlanExternalId(
        registrationData?.planKey,
        ctx.runtime
      );

      const payload = createPayload(registrationData, ctx.runtime);
      const { missing, errors } = validatePayload(payload, planId);

      const shape = Object.fromEntries(
        Object.entries(payload).map(([key, value]) => [key, describeShape(value)])
      );

      debugLog(
        "PATIENT_REGISTRATION_PAYLOAD_SHAPE",
        sanitizeForLog({
          tenantId: ctx.tenantId,
          traceId: ctx.traceId || traceMeta?.traceId || null,
          tracePhone: ctx.tracePhone || traceMeta?.tracePhone || null,
          emptyFields: missing,
          validationErrors: errors,
          shape,
          planKey: registrationData?.planKey || null,
        })
      );

      if (missing.length || errors.length) {
        audit(
          "PATIENT_REGISTRATION_BLOCKED_INVALID_PAYLOAD",
          auditOutcome(
            sanitizeForLog({
              ...(traceMeta || {}),
              tenantId: ctx.tenantId,
              traceId: ctx.traceId || traceMeta?.traceId || null,
              tracePhone: ctx.tracePhone || traceMeta?.tracePhone || null,
              technicalAccepted: false,
              functionalResult: "PATIENT_REGISTRATION_BLOCKED_INVALID_PAYLOAD",
              patientFacingMessage: null,
              escalationRequired: true,
              hasRegistrationData: !!registrationData,
              registrationDataKeys: registrationData
                ? Object.keys(registrationData).sort()
                : [],
              registrationDataShape: registrationData
                ? Object.fromEntries(
                    Object.entries(registrationData).map(([key, value]) => [
                      key,
                      describeShape(value),
                    ])
                  )
                : {},
              missingFields: missing,
              validationErrors: errors,
              planKey: registrationData?.planKey || null,
            })
          )
        );

        return buildResult({
          ok: false,
          status: 400,
          errorCode: "INVALID_REGISTRATION_PAYLOAD",
          errorMessage: "Invalid registration payload",
          data: { missing, errors },
        });
      }

      const out = await versatilisFetch("/api/Login/CadastrarUsuario", {
        tenantId: ctx.tenantId,
        runtime: ctx.runtime,
        method: "POST",
        jsonBody: payload,
        traceMeta: sanitizeForLog(
          mergeTraceMeta(traceMeta, {
            tenantId: ctx.tenantId,
            traceId: ctx.traceId || traceMeta?.traceId || null,
            tracePhone: ctx.tracePhone || traceMeta?.tracePhone || null,
            flow: "CREATE_PATIENT_REGISTRATION",
            planKey: registrationData?.planKey || null,
            documentMasked: "***",
          })
        ),
      });

      audit(
        "PATIENT_REGISTRATION_ATTEMPT",
        auditOutcome(
          sanitizeForLog({
            ...(traceMeta || {}),
            tenantId: ctx.tenantId,
            traceId: ctx.traceId || traceMeta?.traceId || null,
            tracePhone: ctx.tracePhone || traceMeta?.tracePhone || null,
            technicalAccepted: out.ok,
            httpStatus: out.status,
            rid: out.rid,
            functionalResult: out.ok
              ? "PATIENT_REGISTRATION_CREATED"
              : "PATIENT_REGISTRATION_FAILED",
            patientFacingMessage: null,
            escalationRequired: !out.ok,
            dataType: typeof out.data,
            planKey: registrationData?.planKey || null,
          })
        )
      );

      if (!out.ok) {
        return buildResult({
          ok: false,
          status: out.status || 500,
          rid: out.rid || null,
          errorCode: "PATIENT_REGISTRATION_FAILED",
          errorMessage: "Failed to create patient registration",
          data: {
            providerResult: out.data ?? null,
          },
        });
      }

      const patientId =
        parseExternalPatientIdFromAny(out.data) ||
        Number(out?.data?.CodUsuario ?? out?.data?.codUsuario);

      return buildResult({
        ok: true,
        status: out.status || 200,
        rid: out.rid || null,
        data: {
          patientId: Number.isFinite(Number(patientId))
            ? Number(patientId)
            : null,
          providerResult: out.data ?? null,
        },
      });
    },
  };
}

export { createVersatilisPortalAdapter };
