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

// 🔥 AGORA CORRETO: POR CAPABILITY
function resolveProviderConfig(runtime = {}, capability) {
  const cfg = runtime?.integrations?.[capability];

  if (!cfg) {
    const err = new Error(`Provider config ausente para capability: ${capability}`);
    err.code = "PROVIDER_CONFIG_MISSING";
    throw err;
  }

  const baseUrl = sanitizeProviderBase(cfg?.baseUrl);
  const username = readString(cfg?.user);
  const password = readString(cfg?.pass);

  const missing = [];

  if (!baseUrl) missing.push(`${capability}.baseUrl`);
  if (!username) missing.push(`${capability}.user`);
  if (!password) missing.push(`${capability}.pass`);

  if (missing.length) {
    const err = new Error(
      `Provider auth config incompleta (${capability}): ${missing.join(", ")}`
    );
    err.code = "PROVIDER_AUTH_CONFIG_INVALID";
    err.missingFields = missing;
    throw err;
  }

  return {
    providerKey: cfg?.key || capability,
    baseUrl,
    username,
    password,
  };
}

function accessTokenCacheKey(tenantId, providerKey, baseUrl, username) {
  const raw = `${tenantId}|${providerKey}|${baseUrl}|${username}`;
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

async function getProviderAccessToken({ tenantId, runtime, capability }) {
  if (!tenantId) {
    const err = new Error("tenantId ausente em getProviderAccessToken");
    err.code = "TENANT_ID_MISSING";
    throw err;
  }

  if (!runtime) {
    const err = new Error("runtime ausente em getProviderAccessToken");
    err.code = "RUNTIME_MISSING";
    throw err;
  }

  if (!capability) {
    const err = new Error("capability ausente em getProviderAccessToken");
    err.code = "CAPABILITY_MISSING";
    throw err;
  }

  const { providerKey, baseUrl, username, password } =
    resolveProviderConfig(runtime, capability);

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
        tenantId,
        providerKey,
        capability,
        baseUrl: maskBaseUrlForLog(baseUrl),
        error: String(err?.message || err),
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
        tenantId,
        providerKey,
        capability,
        status: response.status,
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
        tenantId,
        providerKey,
        capability,
        baseUrl: maskBaseUrlForLog(baseUrl),
      })
    );

    const err = new Error("Resposta de token do provider inválida.");
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
      tenantId,
      providerKey,
      capability,
      expiresIn,
      tokenMasked: maskToken(token),
      baseUrl: maskBaseUrlForLog(baseUrl),
    })
  );

  return token;
}

function clearProviderAccessTokenCache() {
  accessTokenCache.clear();
}

export { getProviderAccessToken, clearProviderAccessTokenCache };
