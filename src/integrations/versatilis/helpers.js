import { debugLog, audit, auditOutcome } from "../../observability/audit.js";
import { cleanStr, formatCPFMask, isValidEmail, normalizeCEP, parsePositiveInt } from "../../utils/validators.js";
import { maskPhone, maskLoginValue } from "../../utils/mask.js";
import { parseBRDateToISO } from "../../utils/time.js";
import { md5HexLegacyVersatilisOnly, generateTempPassword } from "../../utils/crypto.js";
import { PLAN_KEYS, resolveCodPlano } from "../../config/constants.js";
import { isDebugVersaShapeEnabled } from "../../routes/config/env.js"; // manter separação funcional seria ideal, mas na Fase 1 isso deve ir para um helper compartilhado
import { versatilisFetch, mergeTraceMeta } from "./client.js";

// este import circular acima é o único ponto que não deve ficar assim.
// para fechar a Fase 1, mova isDebugVersaShapeEnabled para config/constants ou env/debug helper.

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
      out[k] = maskLoginValue(v);
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

// बाकी functions: versaFindCodUsuarioByCPF, versaFindCodUsuarioByDadosCPF,
// versaGetDadosUsuarioPorCodigo, versaHadAppointmentLast30Days,
// validatePortalCompleteness, mergeComplementoWithUF, versaCreatePortalCompleto
// permanecem idênticas ao original, apenas trocando imports.
export {
  normalizePlanListFromProfile,
  codPlanoFromPlanKey,
  hasPlanKey,
  sanitizeQueryForLog,
  findCodUsuarioDeep,
  parseCodUsuarioFromAny,
  normalizeCEP,
  validatePortalCompleteness,
  mergeComplementoWithUF,
  versaFindCodUsuarioByCPF,
  versaFindCodUsuarioByDadosCPF,
  versaGetDadosUsuarioPorCodigo,
  versaHadAppointmentLast30Days,
  versaCreatePortalCompleto,
};
