function maskString(value, visibleStart = 2, visibleEnd = 2) {
  const s = String(value ?? "");
  if (!s) return s;
  if (s.length <= visibleStart + visibleEnd) return "***";
  return `${s.slice(0, visibleStart)}***${s.slice(-visibleEnd)}`;
}

function onlyDigits(value) {
  return String(value ?? "").replace(/\D+/g, "");
}

function maskCpf(value) {
  const digits = onlyDigits(value);
  if (!digits) return value;
  if (digits.length !== 11) return "***";
  return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
}

function maskPhone(value) {
  const digits = onlyDigits(value);
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

function maskDate(value) {
  const s = String(value ?? "").trim();
  if (!s) return s;
  return "***";
}

function maskName(value) {
  const s = String(value ?? "").trim();
  if (!s) return s;
  const parts = s.split(/\s+/).filter(Boolean);
  if (!parts.length) return "***";
  return parts.map((p) => `${p.charAt(0)}***`).join(" ");
}

function shouldPreserveKey(key) {
  const k = String(key || "").toLowerCase();
  return (
    k === "traceid" ||
    k === "rid" ||
    k === "tenantid" ||
    k === "state" ||
    k === "status" ||
    k === "statuscode" ||
    k === "httpstatus" ||
    k === "patientid" ||
    k === "codusuario" ||
    k === "slotid" ||
    k === "codhorario" ||
    k === "planid" ||
    k === "codplano" ||
    k === "providerid" ||
    k === "codcolaborador" ||
    k === "endpoint" ||
    k === "method"
  );
}

function sanitizePrimitiveByKey(key, value) {
  const k = String(key || "").toLowerCase();

  if (shouldPreserveKey(k)) {
    return value;
  }

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

  if (
    k.includes("cpf") ||
    k.includes("document") ||
    k.includes("numerodocumento")
  ) {
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
    k.includes("login") ||
    k.includes("usuario") ||
    k.includes("username") ||
    k.includes("user")
  ) {
    return maskString(value, 2, 2);
  }

  if (
    k.includes("birth") ||
    k.includes("nasc") ||
    k.includes("dtnasc") ||
    k.includes("datanascimento")
  ) {
    return maskDate(value);
  }

  if (k.includes("cep")) {
    return maskString(value, 0, 3);
  }

  if (
    k.includes("name") ||
    k.includes("nome")
  ) {
    return maskName(value);
  }

  if (
    k.includes("address") ||
    k.includes("endereco") ||
    k.includes("logradouro") ||
    k.includes("bairro") ||
    k.includes("cidade") ||
    k.includes("uf") ||
    k.includes("numero")
  ) {
    return "***";
  }

  return sanitizePrimitiveByValue(value);
}

function sanitizePrimitiveByValue(value) {
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed) return value;

  if (/^\d{11}$/.test(onlyDigits(trimmed))) {
    return maskCpf(trimmed);
  }

  if (trimmed.includes("@")) {
    return maskEmail(trimmed);
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
    return sanitizePrimitiveByValue(input);
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
