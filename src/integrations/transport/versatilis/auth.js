import crypto from "crypto";
import { fetchWithTimeout } from "../../../utils/time.js";
import { techLog, debugLog } from "../../../observability/audit.js";

const tokenCache = new Map();

function readString(value) {
  const v = String(value ?? "").trim();
  return v || "";
}

function sanitizeVersaBase(value) {
  let s = readString(value);

  if (!s) return "";

  s = s.replace(/\s+/g, "");
  s = s.replace(/\/+$/, "");
  s = s.replace(/\/api\/.*$/i, "");
  s = s.replace(/\/api$/i, "");

  return s;
}

function resolveVersatilisConfig(tenantConfig = {}) {
  const baseUrl = sanitizeVersaBase(
    tenantConfig?.integrations?.versatilis?.baseUrl
  );
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

function maskToken(token) {
  if (!token || typeof token !== "string") return "***";
  return token.length > 16
    ? `${token.slice(0, 6)}...${token.slice(-4)}`
    : "***";
}

export async function versatilisGetToken({ tenantId, tenantConfig }) {
  const { baseUrl, user, pass } = resolveVersatilisConfig(tenantConfig);

  const cacheKey = tokenCacheKey(tenantId, baseUrl, user);
  const now = Date.now();
  const cached = tokenCache.get(cacheKey);

  if (cached && cached.token && cached.expiresAt > now + 30_000) {
    return cached.token;
  }

  const body = new URLSearchParams({
    username: user,
    password: pass,
    grant_type: "password",
  });

  let response;

  try {
    response = await fetchWithTimeout(
      `${baseUrl}/Token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
      },
      15000
    );
  } catch (err) {
    techLog("VERSATILIS_TOKEN_FETCH_TRANSPORT_ERROR", {
      tenantId: tenantId || null,
      baseUrlConfigured: !!baseUrl,
      error: String(err?.message || err),
      cause: err?.cause ? String(err.cause?.message || err.cause) : null,
    });

    const e = new Error("Falha de transporte ao obter token Versatilis.");
    e.code = "VERSATILIS_TOKEN_FETCH_TRANSPORT_ERROR";
    throw e;
  }

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
      tokenPath: "/Token",
      responseType: Array.isArray(data)
        ? "array"
        : data === null
          ? "null"
          : typeof data,
    });

    const err = new Error(
      `Falha ao obter token Versatilis. HTTP ${response.status}`
    );
    err.code = "VERSATILIS_TOKEN_FETCH_FAILED";
    err.httpStatus = response.status;
    throw err;
  }

  const token =
    data?.access_token ||
    data?.token ||
    data?.Token ||
    (typeof data === "string" ? data : null);

  if (!token || typeof token !== "string") {
    techLog("VERSATILIS_TOKEN_INVALID_RESPONSE", {
      tenantId: tenantId || null,
      hasToken: false,
      responseKeys:
        data && typeof data === "object" && !Array.isArray(data)
          ? Object.keys(data).slice(0, 20)
          : [],
    });

    const err = new Error("Resposta de token Versatilis sem token utilizável.");
    err.code = "VERSATILIS_TOKEN_INVALID_RESPONSE";
    throw err;
  }

  const expiresIn =
    Number(data?.expires_in || data?.expires || 3600) || 3600;

  tokenCache.set(cacheKey, {
    token,
    expiresAt: now + Math.max(60, expiresIn) * 1000,
  });

  debugLog("VERSATILIS_TOKEN_FETCH_OK", {
    tenantId: tenantId || null,
    expiresIn,
    tokenMasked: maskToken(token),
  });

  return token;
}

export function clearVersatilisTokenCache() {
  tokenCache.clear();
}
