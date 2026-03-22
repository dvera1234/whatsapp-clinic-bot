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

function buildPortalAdapterResult({
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

function createRegistrationPayload({ registrationData, runtimeCtx }) {
  const resolvedPlanId = resolvePlanIdFromPlanKey(
    registrationData?.planKey,
    runtimeCtx
  );

  const temporaryPasswordHash = md5HexLegacyVersatilisOnly(
    generateTempPassword(10)
  );

  const birthDateISO = cleanStr(registrationData?.birthDateISO);

  const payload = {
    Nome: registrationData?.fullName,
    CPF: registrationData?.document,
    Email: registrationData?.email,
    DtNasc: birthDateISO,
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
    CodPlano: resolvedPlanId ? String(resolvedPlanId) : "",
    CodPlanos: resolvedPlanId ? [resolvedPlanId] : [],
    Senha: temporaryPasswordHash,
  };

  if (
    registrationData?.gender === "M" ||
    registrationData?.gender === "F"
  ) {
    payload.Sexo = registrationData.gender;
  }

  return {
    payload,
    resolvedPlanId,
  };
}

function validateRegistrationPayload(payload, resolvedPlanId) {
  const emptyFields = Object.entries(payload)
    .filter(([_, value]) => isEmptyValue(value))
    .map(([key]) => key);

  const validationErrors = [];

  if (!cleanStr(payload.Nome) || cleanStr(payload.Nome).length < 5) {
    validationErrors.push("Nome");
  }

  if (!/^\d{11}$/.test(String(payload.CPF || "").replace(/\D+/g, ""))) {
    validationErrors.push("CPF");
  }

  if (!isValidEmail(payload.Email)) validationErrors.push("Email");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payload.DtNasc || ""))) {
    validationErrors.push("DtNasc");
  }

  if (!/^\d{8}$/.test(String(payload.CEP || "").replace(/\D+/g, ""))) {
    validationErrors.push("CEP");
  }

  if (!cleanStr(payload.Endereco)) validationErrors.push("Endereco");
  if (!cleanStr(payload.Numero)) validationErrors.push("Numero");
  if (!cleanStr(payload.Bairro)) validationErrors.push("Bairro");
  if (!cleanStr(payload.Cidade)) validationErrors.push("Cidade");
  if (!cleanStr(payload.Celular)) validationErrors.push("Celular");
  if (!cleanStr(payload.Senha)) validationErrors.push("Senha");
  if (!resolvedPlanId) validationErrors.push("CodPlano");

  return {
    emptyFields,
    validationErrors,
  };
}

function createVersatilisPortalAdapter(factoryCtx = {}) {
  return {
    validateRegistrationData({ profile }) {
      const data = validatePatientRegistrationData(profile);

      return buildPortalAdapterResult({
        ok: true,
        data,
        status: 200,
      });
    },

    async createPatientRegistration({
      registrationData,
      traceMeta = {},
      runtimeCtx = {},
    }) {
      const ctx = getProviderRuntimeContext(runtimeCtx, factoryCtx);

      const { payload, resolvedPlanId } = createRegistrationPayload({
        registrationData,
        runtimeCtx: {
          ...runtimeCtx,
          tenantId: ctx.tenantId,
          runtime: ctx.runtime,
        },
      });

      const { emptyFields, validationErrors } = validateRegistrationPayload(
        payload,
        resolvedPlanId
      );

      const shape = Object.fromEntries(
        Object.entries(payload).map(([key, value]) => [key, describeShape(value)])
      );

      debugLog(
        "PATIENT_REGISTRATION_PAYLOAD_SHAPE",
        sanitizeForLog({
          tenantId: ctx.tenantId,
          traceId: ctx.traceId || traceMeta?.traceId || null,
          emptyFields,
          validationErrors,
          shape,
        })
      );

      if (emptyFields.length > 0 || validationErrors.length > 0) {
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
              missingFields: emptyFields,
              validationErrors,
            })
          )
        );

        return buildPortalAdapterResult({
          ok: false,
          status: 400,
          errorCode: "INVALID_REGISTRATION_PAYLOAD",
          errorMessage: "Registration payload is invalid",
          data: {
            stage: "blocked_missing_fields",
            missing: emptyFields,
            validationErrors,
            hint: "Wizard não preencheu dados obrigatórios. Corrigir fluxo WZ_*.",
          },
        });
      }

      const out = await versatilisFetch("/api/Login/CadastrarUsuario", {
        tenantId: ctx.tenantId,
        runtime: ctx.runtime,
        method: "POST",
        jsonBody: payload,
        traceMeta: mergeTraceMeta(traceMeta, {
          tenantId: ctx.tenantId,
          traceId: ctx.traceId || traceMeta?.traceId || null,
          tracePhone: ctx.tracePhone || traceMeta?.tracePhone || null,
          flow: "CREATE_PATIENT_REGISTRATION",
          documentMasked: "***",
        }),
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
          })
        )
      );

      if (!out.ok) {
        return buildPortalAdapterResult({
          ok: false,
          status: out.status || 500,
          rid: out.rid || null,
          errorCode: "PATIENT_REGISTRATION_FAILED",
          errorMessage: "Failed to create patient registration",
          data: {
            stage: "create_registration",
            providerResult: out,
          },
        });
      }

      const patientId =
        parseExternalPatientIdFromAny(out.data) ||
        Number(out?.data?.CodUsuario ?? out?.data?.codUsuario);

      return buildPortalAdapterResult({
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
