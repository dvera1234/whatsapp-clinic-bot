import crypto from "crypto";
import { fetchWithTimeout } from "../../../utils/time.js";
import { techLog, debugLog } from "../../../observability/audit.js";
import { sanitizeForLog } from "../../../utils/logSanitizer.js";

const accessTokenCache = new Map();

function readString(value) {
  const v = String(value ?? "").trim();
  return v || "";
}

function sanitizeProviderBase(value) {
  let s = readString(value);

  if (!s) return "";

  s = s.replace(/\s+/g, "");
  s = s.replace(/\/+$/, "");
  s = s.replace(/\/api\/.*$/i, "");
  s = s.replace(/\/api$/i, "");

  return s;
}

function resolveDefaultProviderConfig(tenantConfig = {}) {
  const providerConfig =
    tenantConfig?.providers?.provider_default ||
    tenantConfig?.providersConfig?.provider_default ||
    {};

  const baseUrl = sanitizeProviderBase(providerConfig?.baseUrl);
  const username = readString(providerConfig?.user);
  const password = readString(providerConfig?.pass);

  const missing = [];
  if (!baseUrl) missing.push("providers.provider_default.baseUrl");
  if (!username) missing.push("providers.provider_default.user");
  if (!password) missing.push("providers.provider_default.pass");

  if (missing.length) {
    const err = new Error(
      `Default provider auth config incompleta: ${missing.join(", ")}`
    );
    err.code = "DEFAULT_PROVIDER_AUTH_CONFIG_INVALID";
    err.missingFields = missing;
    throw err;
  }

  return {
    providerKey: "provider_default",
    baseUrl,
    username,
    password,
  };
}

function accessTokenCacheKey(tenantId, providerKey, baseUrl, username) {
  const raw = `${tenantId || ""}|${providerKey}|${baseUrl}|${username}`;
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

function maskToken(token) {
  if (!token || typeof token !== "string") return "***";
  return token.length > 16
    ? `${token.slice(0, 6)}...${token.slice(-4)}`
    : "***";
}

function maskBaseUrlForLog(baseUrl) {
  const s = readString(baseUrl);
  if (!s) return "";

  try {
    const url = new URL(s);
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return "***";
  }
}

async function getProviderAccessToken({ tenantId, tenantConfig }) {
  const { providerKey, baseUrl, username, password } =
    resolveDefaultProviderConfig(tenantConfig);

  const cacheKey = accessTokenCacheKey(
    tenantId,
    providerKey,
    baseUrl,
    username
  );

  const now = Date.now();
  const cached = accessTokenCache.get(cacheKey);

  if (cached && cached.token && cached.expiresAt > now + 30_000) {
    return cached.token;
  }

  const body = new URLSearchParams({
    username,
    password,
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
    techLog(
      "PROVIDER_ACCESS_TOKEN_FETCH_TRANSPORT_ERROR",
      sanitizeForLog({
        tenantId: tenantId || null,
        providerKey,
        baseUrl: maskBaseUrlForLog(baseUrl),
        baseUrlConfigured: !!baseUrl,
        userConfigured: !!username,
        error: String(err?.message || err),
        cause: err?.cause ? String(err.cause?.message || err.cause) : null,
      })
    );

    const e = new Error("Falha de transporte ao obter token do provider.");
    e.code = "PROVIDER_ACCESS_TOKEN_FETCH_TRANSPORT_ERROR";
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
    techLog(
      "PROVIDER_ACCESS_TOKEN_FETCH_FAILED",
      sanitizeForLog({
        tenantId: tenantId || null,
        providerKey,
        status: response.status,
        tokenPath: "/Token",
        responseType: Array.isArray(data)
          ? "array"
          : data === null
            ? "null"
            : typeof data,
        baseUrl: maskBaseUrlForLog(baseUrl),
      })
    );

    const err = new Error(
      `Falha ao obter token do provider. HTTP ${response.status}`
    );
    err.code = "PROVIDER_ACCESS_TOKEN_FETCH_FAILED";
    err.httpStatus = response.status;
    throw err;
  }

  const token =
    data?.access_token ||
    data?.token ||
    data?.Token ||
    (typeof data === "string" ? data : null);

  if (!token || typeof token !== "string") {
    techLog(
      "PROVIDER_ACCESS_TOKEN_INVALID_RESPONSE",
      sanitizeForLog({
        tenantId: tenantId || null,
        providerKey,
        hasToken: false,
        responseKeys:
          data && typeof data === "object" && !Array.isArray(data)
            ? Object.keys(data).slice(0, 20)
            : [],
        baseUrl: maskBaseUrlForLog(baseUrl),
      })
    );

    const err = new Error("Resposta de token do provider sem token utilizável.");
    err.code = "PROVIDER_ACCESS_TOKEN_INVALID_RESPONSE";
    throw err;
  }

  const expiresIn =
    Number(data?.expires_in || data?.expires || 3600) || 3600;

  accessTokenCache.set(cacheKey, {
    token,
    expiresAt: now + Math.max(60, expiresIn) * 1000,
  });

  debugLog(
    "PROVIDER_ACCESS_TOKEN_FETCH_OK",
    sanitizeForLog({
      tenantId: tenantId || null,
      providerKey,
      expiresIn,
      tokenMasked: maskToken(token),
      baseUrl: maskBaseUrlForLog(baseUrl),
      userConfigured: !!username,
    })
  );

  return token;
}

function clearProviderAccessTokenCache() {
  accessTokenCache.clear();
}

export { getProviderAccessToken, clearProviderAccessTokenCache };
