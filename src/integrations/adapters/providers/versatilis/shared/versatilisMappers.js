import { PLAN_KEYS } from "../../../../../config/constants.js";
import { cleanStr, parsePositiveInt } from "../../../../../utils/validators.js";

function resolveCodPlanoFromRuntime(planKey, runtime = {}) {
  const particular =
    Number(runtime?.codPlanoParticular) ||
    Number(runtime?.tenantConfig?.plans?.codPlanoParticular) ||
    null;

  const medSenior =
    Number(runtime?.codPlanoMedSeniorSp) ||
    Number(runtime?.tenantConfig?.plans?.codPlanoMedSeniorSp) ||
    null;

  if (planKey === PLAN_KEYS.PARTICULAR) return particular;
  if (planKey === PLAN_KEYS.MEDSENIOR_SP) return medSenior;

  return particular;
}

function codPlanoFromPlanKey(planKey, runtime = {}) {
  return resolveCodPlanoFromRuntime(planKey, runtime);
}

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

function hasPlanKey(plansCodList, planKey, runtime = {}) {
  const want = codPlanoFromPlanKey(planKey, runtime);
  return (plansCodList || []).some((x) => Number(x) === Number(want));
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

    if (
      key === "codusuario" ||
      key === "codigousuario" ||
      key.includes("codusuario")
    ) {
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

function mergeComplementoWithUF(complementoUser, uf) {
  const c = cleanStr(complementoUser);
  const U = cleanStr(uf).toUpperCase();
  const base = `UF:${U}`;

  if (!c || c === "0") return base;
  if (c.toUpperCase().includes("UF:")) return c;

  return `${base} | ${c}`;
}

export {
  resolveCodPlanoFromRuntime,
  codPlanoFromPlanKey,
  normalizePlanListFromProfile,
  hasPlanKey,
  findCodUsuarioDeep,
  parseCodUsuarioFromAny,
  mergeComplementoWithUF,
};
