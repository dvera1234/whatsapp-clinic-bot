import {
  COD_COLABORADOR,
} from "../../config/env.js";
import {
  PLAN_KEYS,
  resolveCodPlano,
} from "../../config/constants.js";
import {
  audit,
  auditOutcome,
  debugLog,
} from "../../observability/audit.js";
import { maskPhone } from "../../utils/mask.js";
import {
  cleanStr,
  formatCPFMask,
  isValidEmail,
  normalizeCEP,
  parsePositiveInt,
} from "../../utils/validators.js";
import { parseBRDateToISO } from "../../utils/time.js";
import {
  md5HexLegacyVersatilisOnly,
  generateTempPassword,
} from "../../utils/crypto.js";
import { isDebugVersaShapeEnabled } from "../../config/env.js";
import { mergeTraceMeta, versatilisFetch } from "./client.js";

function normalizePlanListFromProfile(profile) {
  const list = [];

  if (Array.isArray(profile?.CodPlanos)) {
    for (const x of profile.CodPlanos) {
      const n = parsePositiveInt(x);
      if (n) list.push(n);
    }
  }

  const one = parsePositiveInt(profile?.CodPlano);
  if (one) list.push(one);

  return Array.from(new Set(list));
}

function codPlanoFromPlanKey(planKey) {
  return resolveCodPlano(planKey);
}

function hasPlanKey(plansCodList, planKey) {
  const want = codPlanoFromPlanKey(planKey);
  return (plansCodList || []).some((x) => Number(x) === Number(want));
}

function sanitizeQueryForLog(queryObj) {
  if (!queryObj || typeof queryObj !== "object") return null;

  const out = {};
  for (const [k, v] of Object.entries(queryObj)) {
    const key = String(k || "").toLowerCase();

    if (key === "login") {
      const s = String(v || "").trim();

      if (!s) {
        out[k] = "";
      } else if (s.includes("@")) {
        const [user, domain] = s.split("@");
        const u = user.length <= 2 ? "***" : `${user.slice(0, 2)}***`;
        out[k] = `${u}@${domain || "***"}`;
      } else {
        const digits = s.replace(/\D+/g, "");
        out[k] = digits.length >= 6 ? `${digits.slice(0, 2)}***${digits.slice(-2)}` : "***";
      }

      continue;
    }

    if (key === "dtnasc" || key === "datanascimento" || key === "usercpf" || key === "cpf") {
      out[k] = "***";
      continue;
    }

    out[k] = v;
  }

  return out;
}

function findCodUsuarioDeep(obj, depth = 0, maxDepth = 6, seen = new Set()) {
  if (obj == null) return null;

  const direct = parsePositiveInt(obj);
  if (direct) return direct;

  if (typeof obj !== "object") return null;
  if (seen.has(obj)) return null;
  seen.add(obj);

  if (depth > maxDepth) return null;

  if (Array.isArray(obj)) {
    for (const it of obj) {
      const found = findCodUsuarioDeep(it, depth + 1, maxDepth, seen);
      if (found) return found;
    }
    return null;
  }

  for (const [k, v] of Object.entries(obj)) {
    const key = String(k || "").toLowerCase();

    if (key === "codusuario" || key === "codigousuario" || key.includes("codusuario")) {
      const n = parsePositiveInt(v);
      if (n) return n;
      const deep = findCodUsuarioDeep(v, depth + 1, maxDepth, seen);
      if (deep) return deep;
    }
  }

  for (const v of Object.values(obj)) {
    const found = findCodUsuarioDeep(v, depth + 1, maxDepth, seen);
    if (found) return found;
  }

  return null;
}

function parseCodUsuarioFromAny(data) {
  return findCodUsuarioDeep(data);
}

async function versaFindCodUsuarioByCPF(cpfDigits) {
  const cpf = String(cpfDigits || "").replace(/\D+/g, "");
  if (cpf.length !== 11) return null;

  const cpfMask = formatCPFMask(cpf);

  const candidates = [
    `/api/Login/CodUsuario?CPF=${encodeURIComponent(cpf)}`,
    `/api/Login/CodUsuario?cpf=${encodeURIComponent(cpf)}`,
    cpfMask ? `/api/Login/CodUsuario?CPF=${encodeURIComponent(cpfMask)}` : null,
    cpfMask ? `/api/Login/CodUsuario?cpf=${encodeURIComponent(cpfMask)}` : null,
  ].filter(Boolean);

  for (const path of candidates) {
    const out = await versatilisFetch(path);

    if (isDebugVersaShapeEnabled() && out.ok && out.data && typeof out.data === "object") {
      const keys = Object.keys(out.data || {}).slice(0, 30);
      debugLog("VERSA_CODUSUARIO_SHAPE", {
        path,
        keys,
        isArray: Array.isArray(out.data),
      });
    }

    const parsed = out.ok ? parseCodUsuarioFromAny(out.data) : null;

    debugLog("VERSA_CODUSUARIO_LOOKUP_ATTEMPT", {
      technicalAccepted: out.ok,
      httpStatus: out.status,
      path,
      parsedResult: parsed ? "FOUND" : "NOT_FOUND",
    });

    if (!parsed) {
      debugLog("VERSA_CODUSUARIO_LOOKUP_DETAIL", {
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

async function versaFindCodUsuarioByDadosCPF(cpfDigits) {
  const cpf = String(cpfDigits || "").replace(/\D+/g, "");
  if (cpf.length !== 11) return null;

  const cpfMask = formatCPFMask(cpf);

  const candidates = [
    cpfMask ? `/api/Login/DadosUsuarioPorCPF?UserCPF=${encodeURIComponent(cpfMask)}` : null,
    `/api/Login/DadosUsuarioPorCPF?UserCPF=${encodeURIComponent(cpf)}`,
  ].filter(Boolean);

  for (const path of candidates) {
    const out = await versatilisFetch(path);
    const parsed = out.ok ? parseCodUsuarioFromAny(out.data) : null;

    debugLog("VERSA_DADOSUSUARIOPORCPF_LOOKUP_ATTEMPT", {
      technicalAccepted: out.ok,
      httpStatus: out.status,
      path,
      parsedResult: parsed ? "FOUND" : "NOT_FOUND",
    });

    if (!parsed) {
      debugLog("VERSA_DADOSUSUARIOPORCPF_LOOKUP_DETAIL", {
        path,
        httpStatus: out.status,
        dataType: typeof out.data,
      });
    }

    if (parsed) return parsed;
  }

  return null;
}

async function versaGetDadosUsuarioPorCodigo(codUsuario) {
  const id = Number(codUsuario);
  if (!Number.isFinite(id) || id <= 0) return { ok: false, data: null };

  const out = await versatilisFetch(
    `/api/Login/DadosUsuarioPorCodigo?CodUsuario=${encodeURIComponent(id)}`,
    {
      traceMeta: {
        flow: "DADOS_USUARIO_CODIGO",
        codUsuario: id,
      },
    }
  );

  if (!out.ok || !out.data) return { ok: false, data: null };
  return { ok: true, data: out.data };
}

async function versaHadAppointmentLast30Days(codUsuario, traceMeta = {}) {
  if (!codUsuario) return false;

  const out = await versatilisFetch(
    `/api/Agendamento/HistoricoAgendamento?codUsuario=${encodeURIComponent(codUsuario)}`,
    {
      traceMeta: mergeTraceMeta(traceMeta, {
        flow: "RETURN_CHECK_LAST_30_DAYS",
        codUsuario: Number(codUsuario) || null,
      }),
    }
  );

  if (!out.ok || !Array.isArray(out.data)) {
    audit(
      "RETURN_CHECK_HISTORY_UNAVAILABLE",
      auditOutcome({
        ...traceMeta,
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
          ...traceMeta,
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
      ...traceMeta,
      codUsuario: Number(codUsuario) || null,
      technicalAccepted: true,
      functionalResult: "RETURN_CHECK_NEGATIVE",
      patientFacingMessage: null,
      escalationRequired: false,
      historyCount: out.data.length,
    })
  );

  return false;
}

function validatePortalCompleteness(profile) {
  const missing = [];

  const CPF = cleanStr(profile?.CPF).replace(/\D+/g, "");
  const Email = cleanStr(profile?.Email);
  const Celular = cleanStr(profile?.Celular).replace(/\D+/g, "");
  const CEP = cleanStr(profile?.CEP).replace(/\D+/g, "");
  const Endereco = cleanStr(profile?.Endereco);
  const Numero = cleanStr(profile?.Numero);
  const Bairro = cleanStr(profile?.Bairro);
  const Cidade = cleanStr(profile?.Cidade);
  const Complemento = cleanStr(profile?.Complemento);
  const DtNasc = cleanStr(profile?.DtNasc);

  if (!cleanStr(profile?.Nome)) missing.push("nome completo");
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

function mergeComplementoWithUF(complementoUser, uf) {
  const c = cleanStr(complementoUser);
  const U = cleanStr(uf).toUpperCase();
  const base = `UF:${U}`;
  if (!c || c === "0") return base;
  if (c.toUpperCase().includes("UF:")) return c;
  return `${base} | ${c}`;
}

async function versaCreatePortalCompleto({ form, traceMeta = {} }) {
  const planoKey = form.planoKey;
  const codPlano = resolveCodPlano(planoKey);

  const senhaMD5 = md5HexLegacyVersatilisOnly(generateTempPassword(10));
  const dtNascISO = cleanStr(form.dtNascISO);

  const payload = {
    Nome: form.nome,
    CPF: form.cpf,
    Email: form.email,
    DtNasc: dtNascISO,
    Celular: form.celular,
    Telefone: form.telefone || form.celular || "",
    CEP: form.cep,
    Endereco: form.endereco,
    Numero: form.numero,
    Complemento: mergeComplementoWithUF(form.complemento, form.uf),
    Bairro: form.bairro,
    Cidade: form.cidade,
    CodPlano: String(codPlano),
    CodPlanos: [codPlano],
    Senha: senhaMD5,
  };

  if (form.sexoOpt === "M" || form.sexoOpt === "F") {
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

  if (!cleanStr(payload.Nome) || cleanStr(payload.Nome).length < 5) validationErrors.push("Nome");
  if (!/^\d{11}$/.test(String(payload.CPF || "").replace(/\D+/g, ""))) validationErrors.push("CPF");
  if (!isValidEmail(payload.Email)) validationErrors.push("Email");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payload.DtNasc || ""))) validationErrors.push("DtNasc");
  if (!/^\d{8}$/.test(String(payload.CEP || "").replace(/\D+/g, ""))) validationErrors.push("CEP");
  if (!cleanStr(payload.Endereco)) validationErrors.push("Endereco");
  if (!cleanStr(payload.Numero)) validationErrors.push("Numero");
  if (!cleanStr(payload.Bairro)) validationErrors.push("Bairro");
  if (!cleanStr(payload.Cidade)) validationErrors.push("Cidade");
  if (!cleanStr(payload.Celular)) validationErrors.push("Celular");
  if (!cleanStr(payload.Senha)) validationErrors.push("Senha");

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
    empties,
    validationErrors,
    shape,
  });

  if (empties.length > 0 || validationErrors.length > 0) {
    audit(
      "PORTAL_CREATE_BLOCKED_INVALID_PAYLOAD",
      auditOutcome({
        ...traceMeta,
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
    method: "POST",
    jsonBody: payload,
    traceMeta: mergeTraceMeta(traceMeta, {
      flow: "PORTAL_USER_CREATE",
      cpfMasked: "***",
    }),
  });

  audit(
    "PORTAL_USER_CREATE_ATTEMPT",
    auditOutcome({
      ...traceMeta,
      technicalAccepted: out.ok,
      httpStatus: out.status,
      rid: out.rid,
      functionalResult: out.ok ? "PORTAL_USER_CREATED" : "PORTAL_USER_CREATE_FAILED",
      patientFacingMessage: null,
      escalationRequired: !out.ok,
      dataType: typeof out.data,
    })
  );

  if (!out.ok) return { ok: false, stage: "cadastrar", out };

  const codUsuario =
    parseCodUsuarioFromAny(out.data) ||
    Number(out?.data?.CodUsuario ?? out?.data?.codUsuario);

  return {
    ok: true,
    codUsuario: Number.isFinite(Number(codUsuario)) ? Number(codUsuario) : null,
  };
}

export {
  normalizePlanListFromProfile,
  codPlanoFromPlanKey,
  hasPlanKey,
  sanitizeQueryForLog,
  findCodUsuarioDeep,
  parseCodUsuarioFromAny,
  versaFindCodUsuarioByCPF,
  versaFindCodUsuarioByDadosCPF,
  versaGetDadosUsuarioPorCodigo,
  versaHadAppointmentLast30Days,
  validatePortalCompleteness,
  mergeComplementoWithUF,
  versaCreatePortalCompleto,
};
