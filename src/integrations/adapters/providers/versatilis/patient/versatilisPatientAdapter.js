import { isDebugVersaShapeEnabled } from "../../../../../config/env.js";
import { debugLog } from "../../../../../observability/audit.js";
import { formatCPFMask } from "../../../../../utils/validators.js";
import { versatilisFetch } from "../../../../transport/versatilis/client.js";
import { getVersaCtx } from "../shared/versatilisContext.js";
import {
  parseCodUsuarioFromAny,
  normalizePlanListFromProfile,
  hasPlanKey,
} from "../shared/versatilisMappers.js";

function readString(value) {
  const v = String(value ?? "").trim();
  return v || "";
}

function onlyDigits(value) {
  return String(value ?? "").replace(/\D+/g, "");
}

function hasMinText(value, min = 1) {
  return readString(value).length >= min;
}

function hasValidEmail(value) {
  const v = readString(value);
  if (!v) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function hasValidCep(value) {
  return onlyDigits(value).length === 8;
}

function hasValidUf(value) {
  return /^[A-Z]{2}$/.test(readString(value).toUpperCase());
}

function hasDateLike(value) {
  const v = readString(value);
  if (!v) return false;

  return (
    /^\d{2}\/\d{2}\/\d{4}$/.test(v) ||
    /^\d{4}-\d{2}-\d{2}/.test(v)
  );
}

function pickFirst(obj, keys = []) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return "";
}

function validatePortalCompleteness(perfil = {}) {
  const missing = [];

  const nome = pickFirst(perfil, ["Nome", "nome"]);
  const dtNasc = pickFirst(perfil, [
    "DtNasc",
    "DataNascimento",
    "Nascimento",
    "dtNasc",
    "dataNascimento",
  ]);
  const email = pickFirst(perfil, ["Email", "email"]);
  const cep = pickFirst(perfil, ["CEP", "Cep", "cep"]);
  const endereco = pickFirst(perfil, [
    "Endereco",
    "Endereço",
    "Logradouro",
    "endereco",
    "logradouro",
  ]);
  const numero = pickFirst(perfil, ["Numero", "Número", "numero"]);
  const bairro = pickFirst(perfil, ["Bairro", "bairro"]);
  const cidade = pickFirst(perfil, ["Cidade", "cidade"]);
  const uf = pickFirst(perfil, [
    "UF",
    "Uf",
    "Estado",
    "estado",
    "SiglaUF",
    "siglaUf",
  ]);

  if (!hasMinText(nome, 5)) missing.push("nome completo");
  if (!hasDateLike(dtNasc)) missing.push("data de nascimento");
  if (!hasValidEmail(email)) missing.push("e-mail");
  if (!hasValidCep(cep)) missing.push("cep");
  if (!hasMinText(endereco, 3)) missing.push("endereço");
  if (!hasMinText(numero, 1)) missing.push("número");
  if (!hasMinText(bairro, 2)) missing.push("bairro");
  if (!hasMinText(cidade, 2)) missing.push("cidade");
  if (!hasValidUf(uf)) missing.push("estado (uf)");

  return {
    ok: missing.length === 0,
    missing,
  };
}

function createVersatilisPatientAdapter() {
  async function buscarPacientePorCpf({ cpf, runtimeCtx = {} }) {
    const cpfDigits = String(cpf || "").replace(/\D+/g, "");
    if (cpfDigits.length !== 11) return null;

    const ctx = getVersaCtx(runtimeCtx);
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
          flow: "LOOKUP_CODUSUARIO_BY_CPF",
        },
      });

      if (
        isDebugVersaShapeEnabled() &&
        out.ok &&
        out.data &&
        typeof out.data === "object"
      ) {
        const keys = Object.keys(out.data || {}).slice(0, 30);

        debugLog("VERSA_CODUSUARIO_SHAPE", {
          tenantId: ctx.tenantId,
          path,
          keys,
          isArray: Array.isArray(out.data),
        });
      }

      const parsed = out.ok ? parseCodUsuarioFromAny(out.data) : null;

      debugLog("VERSA_CODUSUARIO_LOOKUP_ATTEMPT", {
        tenantId: ctx.tenantId,
        technicalAccepted: out.ok,
        httpStatus: out.status,
        path,
        parsedResult: parsed ? "FOUND" : "NOT_FOUND",
      });

      if (!parsed) {
        debugLog("VERSA_CODUSUARIO_LOOKUP_DETAIL", {
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

  async function buscarPacientePorCpfFallbackDados({ cpf, runtimeCtx = {} }) {
    const cpfDigits = String(cpf || "").replace(/\D+/g, "");
    if (cpfDigits.length !== 11) return null;

    const ctx = getVersaCtx(runtimeCtx);
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
          flow: "LOOKUP_DADOSUSUARIOPORCPF",
        },
      });

      const parsed = out.ok ? parseCodUsuarioFromAny(out.data) : null;

      debugLog("VERSA_DADOSUSUARIOPORCPF_LOOKUP_ATTEMPT", {
        tenantId: ctx.tenantId,
        technicalAccepted: out.ok,
        httpStatus: out.status,
        path,
        parsedResult: parsed ? "FOUND" : "NOT_FOUND",
      });

      if (!parsed) {
        debugLog("VERSA_DADOSUSUARIOPORCPF_LOOKUP_DETAIL", {
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
    async buscarPacientePorCpf({ cpf, runtimeCtx = {} }) {
      return await buscarPacientePorCpf({ cpf, runtimeCtx });
    },

    async buscarPacientePorCpfComFallback({ cpf, runtimeCtx = {} }) {
      const first = await buscarPacientePorCpf({ cpf, runtimeCtx });
      if (first) return first;

      return await buscarPacientePorCpfFallbackDados({ cpf, runtimeCtx });
    },

    async buscarPerfilPaciente({ codUsuario, runtimeCtx = {} }) {
      const ctx = getVersaCtx(runtimeCtx);
      const id = Number(codUsuario);

      if (!Number.isFinite(id) || id <= 0) {
        return { ok: false, data: null };
      }

      const out = await versatilisFetch(
        `/api/Login/DadosUsuarioPorCodigo?CodUsuario=${encodeURIComponent(id)}`,
        {
          tenantId: ctx.tenantId,
          tenantConfig: ctx.tenantConfig,
          traceMeta: {
            tenantId: ctx.tenantId,
            traceId: ctx.traceId,
            flow: "DADOS_USUARIO_CODIGO",
            codUsuario: id,
          },
        }
      );

      if (!out.ok || !out.data) {
        return { ok: false, data: null };
      }

      return { ok: true, data: out.data };
    },

    normalizarPlanosAtivos({ perfil }) {
      return normalizePlanListFromProfile(perfil);
    },

    temPlano({ plansCod, planKey, runtimeCtx = {} }) {
      return hasPlanKey(plansCod, planKey, runtimeCtx);
    },

    validarCadastroCompleto({ perfil }) {
      return validatePortalCompleteness(perfil);
    },
  };
}

export { createVersatilisPatientAdapter };
