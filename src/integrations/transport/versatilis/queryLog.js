import { sanitizeForLog } from "../../../utils/logSanitizer.js";

function sanitizeQueryForLog(queryObj) {
  if (!queryObj || typeof queryObj !== "object") return null;

  const out = {};

  for (const [k, v] of Object.entries(queryObj)) {
    const key = String(k || "").toLowerCase();

    // 🔴 campos sensíveis diretos
    if (
      key.includes("cpf") ||
      key.includes("document") ||
      key.includes("numerodocumento") ||
      key.includes("email") ||
      key.includes("login") ||
      key.includes("usuario") ||
      key.includes("username") ||
      key.includes("dtnasc") ||
      key.includes("datanascimento") ||
      key.includes("birth") ||
      key.includes("nasc")
    ) {
      out[k] = "***";
      continue;
    }

    // 📱 telefone
    if (
      key.includes("phone") ||
      key.includes("telefone") ||
      key.includes("cel") ||
      key.includes("celular") ||
      key.includes("whatsapp")
    ) {
      const digits = String(v ?? "").replace(/\D+/g, "");
      out[k] =
        digits.length >= 4
          ? `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`
          : "***";
      continue;
    }

    // 🔐 token/segurança
    if (
      key.includes("token") ||
      key.includes("auth") ||
      key.includes("authorization") ||
      key.includes("secret") ||
      key.includes("password")
    ) {
      out[k] = "***";
      continue;
    }

    // fallback: sanitiza valor (ex: CPF perdido em campo genérico)
    out[k] = sanitizeForLog(v);
  }

  return out;
}

export { sanitizeQueryForLog };
