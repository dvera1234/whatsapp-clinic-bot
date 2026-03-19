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

function createVersatilisPortalAdapter() {
  return {
    validateRegistrationData({ profile }) {
      return validatePatientRegistrationData(profile);
    },

    async createPatientRegistration({ registrationData, traceMeta = {}, runtimeCtx = {} }) {
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
        Telefone:
          registrationData?.phone || registrationData?.mobilePhone || "",
        CEP: registrationData?.postalCode,
        Endereco: registrationData?.streetAddress,
        Numero: registrationData?.addressNumber,
        Complemento: composeAddressComplement(
          registrationData?.addressComplement,
          registrationData?.stateCode
        ),
        Bairro: registrationData?.district,
        Cidade: registrationData?.city,
        CodPlano: String(resolvedPlanId),
        CodPlanos: resolvedPlanId ? [resolvedPlanId] : [],
        Senha: temporaryPasswordHash,
      };

      if (
        registrationData?.gender === "M" ||
        registrationData?.gender === "F"
      ) {
        payload.Sexo = registrationData.gender;
      }

      function isEmpty(v) {
        if (v == null) return true;
        if (typeof v === "string") return v.trim().length === 0;
        if (Array.isArray(v)) return v.length === 0;
        return false;
      }

      const emptyFields = Object.entries(payload)
        .filter(([_, v]) => isEmpty(v))
        .map(([k]) => k);

      const validationErrors = [];

      if (!cleanStr(payload.Nome) || cleanStr(payload.Nome).length < 5)
        validationErrors.push("Nome");

      if (!/^\d{11}$/.test(String(payload.CPF || "").replace(/\D+/g, "")))
        validationErrors.push("CPF");

      if (!isValidEmail(payload.Email)) validationErrors.push("Email");

      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payload.DtNasc || "")))
        validationErrors.push("DtNasc");

      if (!/^\d{8}$/.test(String(payload.CEP || "").replace(/\D+/g, "")))
        validationErrors.push("CEP");

      if (!cleanStr(payload.Endereco)) validationErrors.push("Endereco");
      if (!cleanStr(payload.Numero)) validationErrors.push("Numero");
      if (!cleanStr(payload.Bairro)) validationErrors.push("Bairro");
      if (!cleanStr(payload.Cidade)) validationErrors.push("Cidade");
      if (!cleanStr(payload.Celular)) validationErrors.push("Celular");
      if (!cleanStr(payload.Senha)) validationErrors.push("Senha");
      if (!resolvedPlanId) validationErrors.push("CodPlano");

      const shape = Object.fromEntries(
        Object.entries(payload).map(([k, v]) => {
          if (typeof v === "string") return [k, `string(len=${v.length})`];
          if (typeof v === "number") return [k, "number"];
          if (Array.isArray(v)) return [k, `array(len=${v.length})`];
          if (typeof v === "boolean") return [k, "boolean"];
          return [k, typeof v];
        })
      );

      debugLog(
        "PATIENT_REGISTRATION_PAYLOAD_SHAPE",
        sanitizeForLog({
          tenantId: runtimeCtx?.tenantId || null,
          traceId: runtimeCtx?.traceId || traceMeta?.traceId || null,
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
              tenantId: runtimeCtx?.tenantId || traceMeta?.tenantId || null,
              traceId: runtimeCtx?.traceId || traceMeta?.traceId || null,
              tracePhone: runtimeCtx?.tracePhone || traceMeta?.tracePhone || null,
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
                    Object.entries(registrationData).map(([k, v]) => {
                      if (v == null) return [k, "null/undefined"];
                      if (typeof v === "string") return [k, `string(len=${v.length})`];
                      if (typeof v === "number") return [k, "number"];
                      if (typeof v === "boolean") return [k, "boolean"];
                      if (Array.isArray(v)) return [k, `array(len=${v.length})`];
                      return [k, typeof v];
                    })
                  )
                : {},
              missingFields: emptyFields,
              validationErrors,
            })
          )
        );

        return {
          ok: false,
          stage: "blocked_missing_fields",
          missing: emptyFields,
          validationErrors,
          hint: "Wizard não preencheu dados obrigatórios. Corrigir fluxo WZ_*.",
        };
      }

      const out = await versatilisFetch("/api/Login/CadastrarUsuario", {
        tenantId: runtimeCtx?.tenantId || null,
        tenantConfig: runtimeCtx?.tenantConfig || null,
        method: "POST",
        jsonBody: payload,
        traceMeta: mergeTraceMeta(traceMeta, {
          tenantId: runtimeCtx?.tenantId || traceMeta?.tenantId || null,
          traceId: runtimeCtx?.traceId || traceMeta?.traceId || null,
          tracePhone: runtimeCtx?.tracePhone || traceMeta?.tracePhone || null,
          flow: "CREATE_PATIENT_REGISTRATION",
          documentMasked: "***",
        }),
      });

      audit(
        "PATIENT_REGISTRATION_ATTEMPT",
        auditOutcome(
          sanitizeForLog({
            ...(traceMeta || {}),
            tenantId: runtimeCtx?.tenantId || traceMeta?.tenantId || null,
            traceId: runtimeCtx?.traceId || traceMeta?.traceId || null,
            tracePhone: runtimeCtx?.tracePhone || traceMeta?.tracePhone || null,
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
        return { ok: false, stage: "create_registration", out };
      }

      const patientId =
        parseExternalPatientIdFromAny(out.data) ||
        Number(out?.data?.CodUsuario ?? out?.data?.codUsuario);

      return {
        ok: true,
        patientId: Number.isFinite(Number(patientId))
          ? Number(patientId)
          : null,
      };
    },
  };
}

export { createVersatilisPortalAdapter };
