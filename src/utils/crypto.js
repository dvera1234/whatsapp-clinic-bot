import crypto from "crypto";

function hashText(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");

  const max = Math.max(aa.length, bb.length, 1);
  const pa = Buffer.alloc(max);
  const pb = Buffer.alloc(max);

  aa.copy(pa);
  bb.copy(pb);

  const same = crypto.timingSafeEqual(pa, pb);
  return same && aa.length === bb.length;
}

// COMPATIBILIDADE LEGADA EXCLUSIVA DO VERSATILIS:
// o endpoint /api/Login/CadastrarUsuario exige "Senha" em hash MD5
function md5HexLegacyVersatilisOnly(s) {
  return crypto.createHash("md5").update(String(s), "utf8").digest("hex");
}

function generateTempPassword(len = 10) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export {
  hashText,
  safeEqual,
  md5HexLegacyVersatilisOnly,
  generateTempPassword,
};
