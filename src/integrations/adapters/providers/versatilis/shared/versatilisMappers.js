import { PLAN_KEYS } from "../../../../../config/constants.js";
import { cleanStr, parsePositiveInt } from "../../../../../utils/validators.js";

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

function hasValidPostalCode(value) {
  return onlyDigits(value).length === 8;
}

function hasValidStateCode(value) {
  return /^[A-Z]{2}$/.test(readString(value).toUpperCase());
}

function hasDateLike(value) {
  const v = readString(value);
  if (!v) return false;

  return /^\d{2}\/\d{2}\/\d{4}$/.test(v) || /^\d{4}-\d{2}-\d{2}/.test(v);
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

function resolveProfileStateCode(profile = {}) {
  return pickFirst(profile, [
    "UF",
    "Uf",
    "uf",
    "EstadoUF",
    "estadoUf",
    "estadoUF",
    "SiglaUF",
    "siglaUf",
    "siglaUF",
    "CdUF",
    "cdUf",
    "cdUF",
  ]);
}

function validatePatientRegistrationData(profile = {}) {
  if (!profile || typeof profile !== "object") {
    return {
      ok: false,
      missing: ["dados do paciente inválidos"],
    };
  }

  const missing = [];

  const fullName = pickFirst(profile, ["Nome", "nome"]);
  const document = pickFirst(profile, ["CPF", "Cpf", "cpf"]);
  const birthDate = pickFirst(profile, [
    "DtNasc",
    "DataNascimento",
    "Nascimento",
    "dtNasc",
    "dataNascimento",
  ]);
  const email = pickFirst(profile, ["Email", "email"]);
  const mobilePhone = pickFirst(profile, ["Celular", "celular"]);
  const postalCode = pickFirst(profile, ["CEP", "Cep", "cep"]);
  const streetAddress = pickFirst(profile, [
    "Endereco",
    "Endereço",
    "Logradouro",
    "endereco",
    "logradouro",
  ]);
  const addressNumber = pickFirst(profile, ["Numero", "Número", "numero"]);
  const district = pickFirst(profile, ["Bairro", "bairro"]);
  const city = pickFirst(profile, ["Cidade", "cidade"]);

  const stateCode = resolveProfileStateCode(profile);
  void stateCode;

  if (!hasMinText(fullName, 5)) missing.push("nome completo");
  if (onlyDigits(document).length !== 11) missing.push("CPF");
  if (!hasDateLike(birthDate)) missing.push("data de nascimento");
  if (!hasValidEmail(email)) missing.push("e-mail");
  if (onlyDigits(mobilePhone).length < 10) missing.push("celular");
  if (!hasValidPostalCode(postalCode)) missing.push("cep");
  if (!hasMinText(streetAddress, 3)) missing.push("endereço");
  if (!hasMinText(addressNumber, 1)) missing.push("número");
  if (!hasMinText(district, 2)) missing.push("bairro");
  if (!hasMinText(city, 2)) missing.push("cidade");

  return {
    ok: missing.length === 0,
    missing,
  };
}

function resolvePlanIdFromPlanKey(planKey, runtime = {}) {
  const privatePlanId = Number(runtime?.plans?.privatePlanId) || null;
  const insuredPlanId = Number(runtime?.plans?.insuredPlanId) || null;

  if (planKey === PLAN_KEYS.PRIVATE) {
    return privatePlanId;
  }

  if (planKey === PLAN_KEYS.INSURED) {
    return insuredPlanId;
  }

  return privatePlanId;
}

function listPlanIdsFromProfile(profile = {}) {
  const list = [];

  if (Array.isArray(profile?.CodPlanos)) {
    for (const x of profile.CodPlanos) {
      const n = parsePositiveInt(x);
      if (n) list.push(n);
    }
  }

  if (Array.isArray(profile?.codPlanos)) {
    for (const x of profile.codPlanos) {
      const n = parsePositiveInt(x);
      if (n) list.push(n);
    }
  }

  const singlePlanId = parsePositiveInt(
    profile?.CodPlano ?? profile?.codPlano ?? null
  );
  if (singlePlanId) list.push(singlePlanId);

  return Array.from(new Set(list));
}

function hasPlanByDomainKey(planIds, planKey, runtime = {}) {
  const expectedPlanId = resolvePlanIdFromPlanKey(planKey, runtime);

  if (!expectedPlanId) return false;

  return (planIds || []).some((x) => Number(x) === Number(expectedPlanId));
}

function findExternalPatientIdDeep(
  obj,
  depth = 0,
  maxDepth = 6,
  seen = new Set()
) {
  if (obj == null) return null;

  const direct = parsePositiveInt(obj);
  if (direct) return direct;

  if (typeof obj !== "object") return null;
  if (seen.has(obj)) return null;
  seen.add(obj);

  if (depth > maxDepth) return null;

  if (Array.isArray(obj)) {
    for (const it of obj) {
      const found = findExternalPatientIdDeep(it, depth + 1, maxDepth, seen);
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

      const deep = findExternalPatientIdDeep(v, depth + 1, maxDepth, seen);
      if (deep) return deep;
    }
  }

  for (const v of Object.values(obj)) {
    const found = findExternalPatientIdDeep(v, depth + 1, maxDepth, seen);
    if (found) return found;
  }

  return null;
}

function parseExternalPatientIdFromAny(data) {
  return findExternalPatientIdDeep(data);
}

function composeAddressComplement(addressComplement, stateCode) {
  const cleanComplement = cleanStr(addressComplement);
  void stateCode;

  if (!cleanComplement || cleanComplement === "0") return "";

  return cleanComplement;
}

export {
  resolvePlanIdFromPlanKey,
  listPlanIdsFromProfile,
  hasPlanByDomainKey,
  findExternalPatientIdDeep,
  parseExternalPatientIdFromAny,
  composeAddressComplement,
  validatePatientRegistrationData,
  resolveProfileStateCode,
  hasValidStateCode,
};
