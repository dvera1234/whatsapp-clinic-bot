function onlyDigits(s) {
  const t = (s || "").trim();
  return /^[0-9]+$/.test(t) ? t : null;
}

function onlyCpfDigits(s) {
  const d = String(s || "").replace(/\D+/g, "");
  return d.length === 11 ? d : null;
}

function normalizeDigits(s) {
  return String(s || "").replace(/\D+/g, "");
}

function normalizeCEP(s) {
  return String(s || "").replace(/\D+/g, "");
}

function normalizeSpaces(s) {
  return (s || "").trim().replace(/\s+/g, " ");
}

function stripControlChars(s) {
  return String(s || "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

function normalizeHumanText(s, maxLen = 120) {
  return stripControlChars(s).replace(/\s+/g, " ").slice(0, maxLen);
}

function isValidName(s) {
  const v = normalizeHumanText(s, 120);
  return (
    v.length >= 5 &&
    /^[A-Za-zÀ-ÿ'´`.-]+(?:\s+[A-Za-zÀ-ÿ'´`.-]+)+$/.test(v)
  );
}

function isValidSimpleAddressField(s, min = 2, max = 120) {
  const v = normalizeHumanText(s, max);
  return v.length >= min;
}

function isValidEmail(s) {
  const t = String(s || "").trim();
  return t.length >= 6 && t.includes("@") && t.includes(".");
}

function cleanStr(s) {
  return String(s ?? "").trim();
}

function parsePositiveInt(v) {
  if (v == null) return null;

  if (typeof v === "number") {
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  if (typeof v === "string") {
    const s = v.trim().replace(/^"+|"+$/g, "");
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  return null;
}

function formatCPFMask(cpf11) {
  const c = String(cpf11 || "").replace(/\D+/g, "");
  if (c.length !== 11) return null;
  return `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9, 11)}`;
}

function formatCellFromWA(phone) {
  return String(phone || "").replace(/\D+/g, "");
}

function formatMissing(list) {
  return list.map((x) => `• ${x}`).join("\n");
}

function formatBRFromISO(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ""));
  if (!m) return isoDate;
  return `${m[3]}/${m[2]}/${m[1]}`;
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
