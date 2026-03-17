import { audit, auditOutcome, debugLog } from "../../../../../observability/audit.js";
import {
  cleanStr,
  isValidEmail,
} from "../../../../../utils/validators.js";
import {
  md5HexLegacyVersatilisOnly,
  generateTempPassword,
} from "../../../../../utils/crypto.js";
import { mergeTraceMeta, versatilisFetch } from "../../../../transport/versatilis/client.js";
import {
  resolveCodPlanoFromRuntime,
  mergeComplementoWithUF,
  parseCodUsuarioFromAny,
} from "../shared/versatilisMappers.js";

function createVersatilisPortalAdapter() {
  function validarCadastroCompleto({ perfil }) {
    const missing = [];

    const CPF = cleanStr(perfil?.CPF).replace(/\D+/g, "");
    const Email = cleanStr(perfil?.Email);
    const Celular = cleanStr(perfil?.Celular).replace(/\D+/g, "");
    const CEP = cleanStr(perfil?.CEP).replace(/\D+/g, "");
    const Endereco = cleanStr(perfil?.Endereco);
    const Numero = cleanStr(perfil?.Numero);
    const Bairro = cleanStr(perfil?.Bairro);
    const Cidade = cleanStr(perfil?.Cidade);
    const Complemento = cleanStr(perfil?.Complemento);
    const DtNasc = cleanStr(perfil?.DtNasc);

    if (!cleanStr(perfil?.Nome)) missing.push("nome completo");
    if (CPF.length !== 11) missing.push("CPF");
    if (!isValidEmail(Email)) missing.push("e-mail");
    if (Celular.length < 10) missing.push("celular");
    if (CEP.length !== 8) missing.push("CEP");
    if (!Endereco) missing.push("endereço");
    if (!Numero) missing.push("número");
    if (!Bairro) missing.push("bairro");
    if (!Cidade) missing.push("cidade");
    if (!DtNasc) missing.push("data de nascimento");

    const hasUF = /\bUF:\s*[A-Z]{2}\b/.test(Complemento.toUpperCase());
    if (!hasUF) missing.push("estado (UF)");

    return { ok: missing.length === 0, missing };
  }

  return {
    validarCadastroCompleto,

    async criarCadastroCompleto({ form, traceMeta = {}, runtimeCtx = {} }) {
      const codPlano = resolveCodPlanoFromRuntime(form?.planoKey, runtimeCtx);
      const senhaMD5 = md5HexLegacyVersatilisOnly(generateTempPassword(10));
      const dtNascISO = cleanStr(form?.dtNascISO);

      const payload = {
        Nome: form?.nome,
        CPF: form?.cpf,
        Email: form?.email,
        DtNasc: dtNascISO,
        Celular: form?.celular,
        Telefone: form?.telefone || form?.celular || "",
        CEP: form?.cep,
        Endereco: form?.endereco,
        Numero: form?.numero,
        Complemento: mergeComplementoWithUF(form?.complemento, form?.uf),
        Bairro: form?.bairro,
        Cidade: form?.cidade,
        CodPlano: String(codPlano),
        CodPlanos: codPlano ? [codPlano] : [],
        Senha: senhaMD5,
      };

      if (form?.sexoOpt === "M" || form?.sexoOpt === "F") {
        payload.Sexo = form.sexoOpt;
      }

      function isEmpty(v) {
        if (v == null) return true;
        if (typeof v === "string") return v.trim().length === 0;
        if (Array.isArray(v)) return v.length === 0;
        return false;
      }

      const empties = Object.entries(payload)
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
      if (!codPlano) validationErrors.push("CodPlano");

      const shape = Object.fromEntries(
        Object.entries(payload).map(([k, v]) => {
          if (typeof v === "string") return [k, `string(len=${v.length})`];
          if (typeof v === "number") return [k, "number"];
          if (Array.isArray(v)) return [k, `array(len=${v.length})`];
          if (typeof v === "boolean") return [k, "boolean"];
          return [k, typeof v];
        })
      );

      debugLog("PORTAL_CREATE_PAYLOAD_SHAPE", {
        tenantId: runtimeCtx?.tenantId || null,
        empties,
        validationErrors,
        shape,
      });

      if (empties.length > 0 || validationErrors.length > 0) {
        audit(
          "PORTAL_CREATE_BLOCKED_INVALID_PAYLOAD",
          auditOutcome({
            ...(traceMeta || {}),
            tenantId: runtimeCtx?.tenantId || traceMeta?.tenantId || null,
            traceId: runtimeCtx?.traceId || traceMeta?.traceId || null,
            tracePhone: runtimeCtx?.tracePhone || traceMeta?.tracePhone || null,
            technicalAccepted: false,
            functionalResult: "PORTAL_CREATE_BLOCKED_INVALID_PAYLOAD",
            patientFacingMessage: null,
            escalationRequired: true,
            hasForm: !!form,
            formKeys: form ? Object.keys(form).sort() : [],
            formShape: form
              ? Object.fromEntries(
                  Object.entries(form).map(([k, v]) => {
                    if (v == null) return [k, "null/undefined"];
                    if (typeof v === "string") return [k, `string(len=${v.length})`];
                    if (typeof v === "number") return [k, "number"];
                    if (typeof v === "boolean") return [k, "boolean"];
                    if (Array.isArray(v)) return [k, `array(len=${v.length})`];
                    return [k, typeof v];
                  })
                )
              : {},
            missingFields: empties,
            validationErrors,
          })
        );

        return {
          ok: false,
          stage: "blocked_missing_fields",
          missing: empties,
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
          flow: "PORTAL_USER_CREATE",
          cpfMasked: "***",
        }),
      });

      audit(
        "PORTAL_USER_CREATE_ATTEMPT",
        auditOutcome({
          ...(traceMeta || {}),
          tenantId: runtimeCtx?.tenantId || traceMeta?.tenantId || null,
          traceId: runtimeCtx?.traceId || traceMeta?.traceId || null,
          tracePhone: runtimeCtx?.tracePhone || traceMeta?.tracePhone || null,
          technicalAccepted: out.ok,
          httpStatus: out.status,
          rid: out.rid,
          functionalResult: out.ok
            ? "PORTAL_USER_CREATED"
            : "PORTAL_USER_CREATE_FAILED",
          patientFacingMessage: null,
          escalationRequired: !out.ok,
          dataType: typeof out.data,
        })
      );

      if (!out.ok) {
        return { ok: false, stage: "cadastrar", out };
      }

      const codUsuario =
        parseCodUsuarioFromAny(out.data) ||
        Number(out?.data?.CodUsuario ?? out?.data?.codUsuario);

      return {
        ok: true,
        codUsuario: Number.isFinite(Number(codUsuario))
          ? Number(codUsuario)
          : null,
      };
    },
  };
}

export { createVersatilisPortalAdapter };
