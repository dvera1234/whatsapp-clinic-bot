import crypto from "crypto";
import { fetchWithTimeout } from "../../../utils/time.js";
import { techLog, debugLog } from "../../../observability/audit.js";
import { sanitizeForLog } from "../../../utils/logSanitizer.js";
import {
  ProviderAuthError,
  ProviderBadResponseError,
  ProviderNetworkError,
  ProviderTimeoutError,
} from "../../adapters/providers/versatilis/shared/versatilisErrors.js";

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

function resolveProviderConfig(runtime = {}, capability) {
  const cfg = runtime?.integrations?.[capability];

  if (!cfg || typeof cfg !== "object") {
    throw new ProviderAuthError(
      `Provider config ausente para capability: ${capability}`,
      {
        meta: {
          capability,
        },
      }
    );
  }

  const baseUrl = sanitizeProviderBase(cfg?.baseUrl);
  const username = readString(cfg?.user);
  const password = readString(cfg?.pass);

  const missing = [];

  if (!baseUrl) missing.push(`${capability}.baseUrl`);
  if (!username) missing.push(`${capability}.user`);
  if (!password) missing.push(`${capability}.pass`);

  if (missing.length) {
    throw new ProviderAuthError(
      `Provider auth config incompleta (${capability})`,
      {
        meta: {
          capability,
          missingFields: missing,
        },
      }
    );
  }

  return {
    providerKey: readString(cfg?.key) || capability,
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

function parseTokenResponse(data) {
  const token =
    data?.access_token ||
    data?.token ||
    data?.Token ||
    (typeof data === "string" ? data : null);

  if (!token || typeof token !== "string") {
    return null;
  }

  const expiresIn =
    Number(data?.expires_in || data?.expires || 3600) || 3600;

  return {
    token,
    expiresIn,
  };
}

async function getProviderAccessToken({ tenantId, runtime, capability }) {
  if (!tenantId) {
    throw new ProviderAuthError("tenantId ausente em getProviderAccessToken", {
      meta: { capability },
    });
  }

  if (!runtime || typeof runtime !== "object") {
    throw new ProviderAuthError("runtime ausente em getProviderAccessToken", {
      meta: { tenantId, capability },
    });
  }

  if (!capability) {
    throw new ProviderAuthError(
      "capability ausente em getProviderAccessToken",
      {
        meta: { tenantId },
      }
    );
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

    const msg = String(err?.message || "").toLowerCase();

    if (msg.includes("timeout")) {
      throw new ProviderTimeoutError(
        "Falha por timeout ao obter token do provider",
        {
          endpoint: "/Token",
          meta: {
            tenantId,
            providerKey,
            capability,
          },
        }
      );
    }

    throw new ProviderNetworkError(
      "Falha de transporte ao obter token do provider",
      {
        endpoint: "/Token",
        meta: {
          tenantId,
          providerKey,
          capability,
        },
      }
    );
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

    throw new ProviderAuthError(
      `Falha ao obter token do provider. HTTP ${response.status}`,
      {
        endpoint: "/Token",
        httpStatus: response.status,
        meta: {
          tenantId,
          providerKey,
          capability,
        },
      }
    );
  }

  const parsed = parseTokenResponse(data);

  if (!parsed) {
    techLog(
      "PROVIDER_ACCESS_TOKEN_INVALID_RESPONSE",
      sanitizeForLog({
        tenantId,
        providerKey,
        capability,
        baseUrl: maskBaseUrlForLog(baseUrl),
      })
    );

    throw new ProviderBadResponseError(
      "Resposta de token do provider inválida",
      {
        endpoint: "/Token",
        meta: {
          tenantId,
          providerKey,
          capability,
        },
      }
    );
  }

  accessTokenCache.set(cacheKey, {
    token: parsed.token,
    expiresAt: now + Math.max(60, parsed.expiresIn) * 1000,
  });

  debugLog(
    "PROVIDER_ACCESS_TOKEN_FETCH_OK",
    sanitizeForLog({
      tenantId,
      providerKey,
      capability,
      expiresIn: parsed.expiresIn,
      tokenMasked: maskToken(parsed.token),
      baseUrl: maskBaseUrlForLog(baseUrl),
    })
  );

  return parsed.token;
}

function clearProviderAccessTokenCache({
  tenantId,
  runtime,
  capability,
} = {}) {
  if (!tenantId && !runtime && !capability) {
    accessTokenCache.clear();
    return;
  }

  const keysToDelete = [];

  for (const key of accessTokenCache.keys()) {
    let shouldDelete = true;

    if (tenantId) {
      shouldDelete = shouldDelete && typeof key === "string";
    }

    if (shouldDelete) {
      keysToDelete.push(key);
    }
  }

  if (tenantId && runtime && capability) {
    try {
      const { providerKey, baseUrl, username } = resolveProviderConfig(
        runtime,
        capability
      );

      const exactKey = accessTokenCacheKey(
        tenantId,
        providerKey,
        baseUrl,
        username
      );

      accessTokenCache.delete(exactKey);
      return;
    } catch {
      return;
    }
  }

  for (const key of keysToDelete) {
    accessTokenCache.delete(key);
  }
}

export {
  getProviderAccessToken,
  clearProviderAccessTokenCache,
  resolveProviderConfig,
};
