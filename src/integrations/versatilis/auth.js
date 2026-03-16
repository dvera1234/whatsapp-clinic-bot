import { VERSATILIS_BASE, VERSATILIS_USER, VERSATILIS_PASS } from "../../config/env.js";
import { opLog } from "../../observability/audit.js";
import { maskToken, maskUrl } from "../../utils/mask.js";
import { fetchWithTimeout } from "../../utils/time.js";

function sanitizeVersaBase(u) {
  let s = String(u).trim();

  s = s.replace(/\s+/g, "");
  s = s.replace(/\/+$/, "");
  s = s.replace(/\/api\/.*$/i, "");
  s = s.replace(/\/api$/i, "");

  return s;
}

const VERSA_BASE = sanitizeVersaBase(VERSATILIS_BASE);

opLog("VERSATILIS_BASE_CONFIG", {
  raw: maskUrl(VERSATILIS_BASE),
  sanitized: maskUrl(VERSA_BASE),
});

let versaToken = null;
let versaTokenExpMs = 0;

async function versatilisGetToken() {
  const now = Date.now();
  if (versaToken && now < versaTokenExpMs - 30_000) return versaToken;

  if (!VERSA_BASE || !VERSATILIS_USER || !VERSATILIS_PASS) {
    throw new Error("Versatilis ENV ausente (VERSATILIS_BASE/USER/PASS).");
  }

  const body = new URLSearchParams({
    username: VERSATILIS_USER,
    password: VERSATILIS_PASS,
    grant_type: "password",
  });

  const r = await fetchWithTimeout(
    `${VERSA_BASE}/Token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
    15000
  );

  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`Versatilis Token falhou status=${r.status}`);
  }

  versaToken = json.access_token;
  const exp = Number(json.expires_in || 0);
  versaTokenExpMs = Date.now() + Math.max(60, exp) * 1000;

  opLog("VERSATILIS_TOKEN_REFRESH_OK", {
    token: maskToken(versaToken),
  });

  return versaToken;
}

export {
  VERSA_BASE,
  sanitizeVersaBase,
  versatilisGetToken,
};
