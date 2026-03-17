import crypto from "crypto";
import { fetchWithTimeout } from "../../utils/time.js";
import { techLog } from "../../observability/audit.js";

const tokenCache = new Map();

function readString(value) {
  const v = String(value ?? "").trim();
  return v || "";
}

function resolveVersatilisConfig(tenantConfig = {}) {
  const baseUrl = readString(tenantConfig?.integrations?.versatilis?.baseUrl);
  const user = readString(tenantConfig?.integrations?.versatilis?.user);
  const pass = readString(tenantConfig?.integrations?.versatilis?.pass);

  const missing = [];
  if (!baseUrl) missing.push("integrations.versatilis.baseUrl");
  if (!user) missing.push("integrations.versatilis.user");
  if (!pass) missing.push("integrations.versatilis.pass");

  if (missing.length) {
    const err = new Error(
      `Versatilis config incompleta: ${missing.join(", ")}`
    );
    err.code = "VERSATILIS_CONFIG_INVALID";
    err.missingFields = missing;
    throw err;
  }

  return { baseUrl, user, pass };
}

function tokenCacheKey(tenantId, baseUrl, user) {
  const raw = `${tenantId || ""}|${baseUrl}|${user}`;
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

export async function versatilisGetToken({ tenantId, tenantConfig }) {
  const { baseUrl, user, pass } = resolveVersatilisConfig(tenantConfig);

  const cacheKey = tokenCacheKey(tenantId, baseUrl, user);
  const now = Date.now();
  const cached = tokenCache.get(cacheKey);

  if (cached && cached.token && cached.expiresAt > now + 15_000) {
    return cached.token;
  }

  const url = `${baseUrl}/api/Login/GetToken`;
  const body = JSON.stringify({
    Usuario: user,
    Senha: pass,
  });

  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body,
    },
    15000
  );

  const text = await response.text().catch(() => "");
  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    techLog("VERSATILIS_TOKEN_FETCH_FAILED", {
      tenantId: tenantId || null,
      status: response.status,
    });

    const err = new Error(
      `Falha ao obter token Versatilis. HTTP ${response.status}`
    );
    err.code = "VERSATILIS_TOKEN_FETCH_FAILED";
    err.httpStatus = response.status;
    throw err;
  }

  const token =
    data?.Token ||
    data?.token ||
    data?.access_token ||
    (typeof data === "string" ? data : null);

  if (!token || typeof token !== "string") {
    const err = new Error("Resposta de token Versatilis sem token utilizável.");
    err.code = "VERSATILIS_TOKEN_INVALID_RESPONSE";
    throw err;
  }

  tokenCache.set(cacheKey, {
    token,
    expiresAt: now + 50 * 60 * 1000,
  });

  return token;
}
