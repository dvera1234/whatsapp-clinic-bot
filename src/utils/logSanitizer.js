function maskString(value, visibleStart = 2, visibleEnd = 2) {
  const s = String(value ?? "");
  if (!s) return s;
  if (s.length <= visibleStart + visibleEnd) return "***";
  return `${s.slice(0, visibleStart)}***${s.slice(-visibleEnd)}`;
}

function maskCpf(value) {
  const digits = String(value ?? "").replace(/\D+/g, "");
  if (!digits) return value;
  if (digits.length !== 11) return "***";
  return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
}

function maskPhone(value) {
  const digits = String(value ?? "").replace(/\D+/g, "");
  if (!digits) return value;
  if (digits.length < 4) return "***";
  return `${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

function maskEmail(value) {
  const s = String(value ?? "").trim();
  if (!s || !s.includes("@")) return value;
  const [user, domain] = s.split("@");
  const safeUser = user.length <= 2 ? "***" : `${user.slice(0, 2)}***`;
  return `${safeUser}@${domain}`;
}

function sanitizePrimitiveByKey(key, value) {
  const k = String(key || "").toLowerCase();

  if (
    k.includes("token") ||
    k.includes("secret") ||
    k.includes("password") ||
    k.includes("passwd") ||
    k.includes("authorization") ||
    k.includes("auth")
  ) {
    return "***";
  }

  if (k.includes("cpf") || k.includes("document")) {
    return maskCpf(value);
  }

  if (
    k.includes("phone") ||
    k.includes("telefone") ||
    k.includes("cel") ||
    k.includes("whatsapp")
  ) {
    return maskPhone(value);
  }

  if (k.includes("email")) {
    return maskEmail(value);
  }

  if (
    k.includes("name") ||
    k.includes("nome") ||
    k.includes("address") ||
    k.includes("endereco") ||
    k.includes("birth") ||
    k.includes("nasc")
  ) {
    return "***";
  }

  return value;
}

export function sanitizeForLog(input, depth = 0) {
  if (depth > 6) return "[MaxDepth]";

  if (input == null) return input;

  if (Array.isArray(input)) {
    return input.map((item) => sanitizeForLog(item, depth + 1));
  }

  if (typeof input !== "object") {
    return input;
  }

  const out = {};

  for (const [key, value] of Object.entries(input)) {
    if (value && typeof value === "object") {
      out[key] = sanitizeForLog(value, depth + 1);
    } else {
      out[key] = sanitizePrimitiveByKey(key, value);
    }
  }

  return out;
}
