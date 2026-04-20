import { normalizeHumanText } from "../../utils/validators.js";
import { getWizardFieldMap } from "./contentHelpers.js";

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function formatMissing(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => `• ${String(item ?? "").trim()}`)
    .filter((item) => item !== "•")
    .join("\n");
}

export function formatPhoneFromWA(phone) {
  return String(phone || "").replace(/\D+/g, "");
}

export function isValidName(value) {
  const normalized = normalizeHumanText(value, 120);

  return (
    normalized.length >= 5 &&
    /^[A-Za-zÀ-ÿ'´`.-]+(?:\s+[A-Za-zÀ-ÿ'´`.-]+)+$/.test(normalized)
  );
}

export function isValidSimpleAddressField(value, min = 2, max = 120) {
  const normalized = normalizeHumanText(value, max);
  return normalized.length >= min;
}

export function nextWizardStateFromMissing(runtime, missingList) {
  const fieldStateMap = getWizardFieldMap(runtime);

  for (const rawKey of Array.isArray(missingList) ? missingList : []) {
    const missingKey = readString(rawKey);
    if (!missingKey) continue;

    const targetState = readString(fieldStateMap[missingKey]);
    if (targetState) {
      return targetState;
    }
  }

  const fallbackState =
    readString(fieldStateMap.nomeCompleto) ||
    readString(fieldStateMap.nome) ||
    readString(fieldStateMap.defaultState);

  if (!fallbackState) {
    throw new Error("TENANT_CONTENT_MISSING:wizard.fieldStateMap.defaultState");
  }

  return fallbackState;
}
