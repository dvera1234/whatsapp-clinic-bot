function onlyDigits(value) {
  return String(value || "").replace(/\D+/g, "");
}

function onlyCpfDigits(value) {
  const digits = onlyDigits(value);
  return digits.length === 11 ? digits : null;
}

function normalizeDigits(value) {
  return onlyDigits(value);
}

function normalizeCEP(value) {
  return onlyDigits(value);
}

function normalizeSpaces(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function stripControlChars(value) {
  return String(value || "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

function normalizeHumanText(value, maxLen = 120) {
  return stripControlChars(value).replace(/\s+/g, " ").slice(0, maxLen);
}

function isValidName(value) {
  const normalized = normalizeHumanText(value, 120);

  return (
    normalized.length >= 5 &&
    /^[A-Za-zÀ-ÿ'´`.-]+(?:\s+[A-Za-zÀ-ÿ'´`.-]+)+$/.test(normalized)
  );
}

function isValidSimpleAddressField(value, min = 2, max = 120) {
  const normalized = normalizeHumanText(value, max);
  return normalized.length >= min;
}

function isValidEmail(value) {
  const email = String(value || "").trim();

  if (!email || email.length > 254) return false;

  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function cleanStr(value) {
  return String(value ?? "").trim();
}

function parsePositiveInt(value) {
  if (value == null) return null;

  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  if (typeof value === "string") {
    const normalized = value.trim().replace(/^"+|"+$/g, "");
    const numberValue = Number(normalized);
    return Number.isFinite(numberValue) && numberValue > 0
      ? numberValue
      : null;
  }

  return null;
}

function formatCPFMask(cpf11) {
  const digits = onlyDigits(cpf11);
  if (digits.length !== 11) return null;

  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9, 11)}`;
}

function formatCellFromWA(phone) {
  return onlyDigits(phone);
}

function formatMissing(list) {
  return list.map((item) => `• ${item}`).join("\n");
}

function formatBRFromISO(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ""));
  if (!match) return isoDate;

  return `${match[3]}/${match[2]}/${match[1]}`;
}

export {
  onlyDigits,
  onlyCpfDigits,
  normalizeDigits,
  normalizeCEP,
  normalizeSpaces,
  stripControlChars,
  normalizeHumanText,
  isValidName,
  isValidSimpleAddressField,
  isValidEmail,
  cleanStr,
  parsePositiveInt,
  formatCPFMask,
  formatCellFromWA,
  formatMissing,
  formatBRFromISO,
};
