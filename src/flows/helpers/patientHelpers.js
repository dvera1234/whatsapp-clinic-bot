import { normalizeHumanText } from "../../utils/validators.js";

export function formatMissing(list) {
  return list.map((x) => `• ${x}`).join("\n");
}

export function formatPhoneFromWA(phone) {
  return String(phone || "").replace(/\D+/g, "");
}

export function isValidName(s) {
  const v = normalizeHumanText(s, 120);
  return (
    v.length >= 5 &&
    /^[A-Za-zÀ-ÿ'´`.-]+(?:\s+[A-Za-zÀ-ÿ'´`.-]+)+$/.test(v)
  );
}

export function isValidSimpleAddressField(s, min = 2, max = 120) {
  const v = normalizeHumanText(s, max);
  return v.length >= min;
}

export function nextWizardStateFromMissing(missingList) {
  const m = new Set((missingList || []).map((x) => String(x).toLowerCase()));

  if (m.has("nome completo")) return "WZ_NOME";
  if (m.has("data de nascimento")) return "WZ_DTNASC";
  if (m.has("e-mail")) return "WZ_EMAIL";
  if (m.has("cep")) return "WZ_CEP";
  if (m.has("endereço")) return "WZ_ENDERECO";
  if (m.has("número")) return "WZ_NUMERO";
  if (m.has("bairro")) return "WZ_BAIRRO";
  if (m.has("cidade")) return "WZ_CIDADE";
  if (m.has("estado (UF)")) return "WZ_UF";

  return "WZ_NOME";
}

export function hasPlanKey({ planIds, runtime, planKey }) {
  const externalId =
    runtime?.planMappings?.[planKey]?.externalId != null
      ? Number(runtime.planMappings[planKey].externalId)
      : null;

  const normalizedPlanIds = Array.isArray(planIds)
    ? planIds.map((x) => Number(x)).filter(Number.isFinite)
    : [];

  return externalId != null && normalizedPlanIds.includes(externalId);
}
