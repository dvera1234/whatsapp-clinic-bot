import crypto from "crypto";
import { debugLog, techLog } from "../../../observability/audit.js";
import {
  canLog,
  log,
  logRateLimited,
} from "../../../observability/logger.js";
import { fetchWithTimeout } from "../../../utils/time.js";
import { sanitizeForLog } from "../../../utils/logSanitizer.js";
import { getProviderAccessToken, resolveProviderConfig } from "./auth.js";
import { sanitizeQueryForLog } from "./queryLog.js";
import {
  ProviderBadResponseError,
  ProviderNetworkError,
  ProviderTimeoutError,
  normalizeProviderError,
} from "../../adapters/providers/versatilis/shared/versatilisErrors.js";

function readString(value) {
  const v = String(value ?? "").trim();
  return v || "";
}

function resolveProviderBaseUrl(runtime = {}, capability) {
  if (!capability) {
    throw new ProviderBadResponseError(
      "Capability obrigatória para resolver baseUrl do provider",
      {
        meta: {
          capability,
        },
      }
    );
  }

  const cfg = resolveProviderConfig(runtime, capability);
  const baseUrl = readString(cfg?.baseUrl);

  if (!baseUrl) {
    throw new ProviderBadResponseError(
      "Base URL do provider ausente no runtime",
      {
        meta: {
          capability,
        },
      }
    );
  }

  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function mergeTraceMeta(base, extra) {
  return {
    ...(base || {}),
    ...(extra || {}),
  };
}

function sanitizePathForLog(path) {
  const raw = String(path || "");
  if (!raw) return raw;

  try {
    const fakeUrl = new URL(raw, "https://sanitizer.local");

    const sensitiveKeys = new Set([
      "cpf",
      "usercpf",
      "dtnasc",
      "datanascimento",
      "login",
      "email",
      "codusuario",
    ]);

    for (const [key] of fakeUrl.searchParams.entries()) {
      const lower = String(key || "").toLowerCase();

      if (sensitiveKeys.has(lower)) {
        fakeUrl.searchParams.set(key, "***");
      }
    }

    return `${fakeUrl.pathname}${fakeUrl.search}`;
  } catch {
    return raw
      .replace(/(cpf=)[^&]+/gi, "$1***")
      .replace(/(usercpf=)[^&]+/gi, "$1***")
      .replace(/(dtnasc=)[^&]+/gi, "$1***")
      .replace(/(datanascimento=)[^&]+/gi, "$1***")
      .replace(/(login=)[^&]+/gi, "$1***")
      .replace(/(email=)[^&]+/gi, "$1***")
      .replace(/(codusuario=)[^&]+/gi, "$1***");
  }
}

function parseResponseData(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function classifyExpected404({ status, data }) {
  if (status !== 404) return false;

  if (Array.isArray(data)) return false;

  if (data && typeof data === "object") {
    return true;
  }

  if (typeof data === "string") {
    const normalizedText = data.toLowerCase();

    return (
      normalizedText.includes("não foram encontradas") ||
      normalizedText.includes("não foram encontrados") ||
      normalizedText.includes("usuário não encontrado") ||
      normalizedText.includes("agendamento não encontrado")
    );
  }

  return false;
}

async function providerFetch(
  path,
  {
    method = "GET",
    jsonBody,
    extraHeaders,
    traceMeta,
    tenantId,
    runtime,
    capability,
  } = {}
) {
  const requestId = crypto.randomUUID();

  if (!tenantId) {
    throw new ProviderBadResponseError("tenantId ausente em providerFetch", {
      meta: { capability },
    });
  }

  if (!runtime || typeof runtime !== "object") {
    throw new ProviderBadResponseError("runtime ausente em providerFetch", {
      meta: { tenantId, capability },
    });
  }

  if (!capability) {
    throw new ProviderBadResponseError(
      "capability obrigatória em providerFetch",
      {
        meta: { tenantId },
      }
    );
  }

  const baseUrl = resolveProviderBaseUrl(runtime, capability);

  const accessToken = await getProviderAccessToken({
    tenantId,
    runtime,
    capability,
  });

  const url = `${baseUrl}${path}`;
  const startedAt = Date.now();

  let query = null;
  try {
    const u = new URL(url);
    query = Object.fromEntries(u.searchParams.entries());
  } catch {}

  const safeQuery = sanitizeQueryForLog(query);

  let response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          ...(jsonBody ? { "Content-Type": "application/json" } : {}),
          ...(extraHeaders || {}),
        },
        body: jsonBody ? JSON.stringify(jsonBody) : undefined,
      },
      15000
    );
  } catch (err) {
    const message = String(err?.message || "").toLowerCase();

    const normalizedErr = message.includes("timeout")
      ? new ProviderTimeoutError("Provider request timeout", {
          endpoint: path,
          rid: requestId,
          meta: {
            tenantId,
            capability,
          },
        })
      : new ProviderNetworkError("Provider network failure", {
          endpoint: path,
          rid: requestId,
          meta: {
            tenantId,
            capability,
          },
        });

    techLog(
      "PROVIDER_CALL_TRANSPORT_ERROR",
      sanitizeForLog({
        rid: requestId,
        method,
        path: sanitizePathForLog(path),
        tenantId,
        capability,
        ...(traceMeta || {}),
        error: normalizedErr.message,
        errorCode: normalizedErr.code,
      })
    );

    throw normalizedErr;
  }

  const durationMs = Date.now() - startedAt;

  const allow =
    response.headers.get("allow") || response.headers.get("Allow") || null;

  const contentType = response.headers.get("content-type") || null;

  const text = await response.text().catch(() => "");
  const textLen = text ? text.length : 0;
  const data = parseResponseData(text);

  const isExpected404 = classifyExpected404({
    status: response.status,
    data,
  });

  const technicalResult = response.ok
    ? "API_ACCEPTED"
    : isExpected404
      ? "EXPECTED_EMPTY_RESULT"
      : "API_REJECTED";

  const safePath = sanitizePathForLog(path);

  const baseLogRaw = {
    rid: requestId,
    method,
    path: safePath,
    status: response.status,
    ms: durationMs,
    query: safeQuery,
    hasBody: !!jsonBody,
    technicalResult,
    capability,
    ...(traceMeta || {}),
    tenantId,
  };

  const baseLog = sanitizeForLog(baseLogRaw);

  if (isExpected404) {
    const rateLimitKey = `expected404:${tenantId}:${method}:${safePath.split("?")[0]}`;

    logRateLimited(
      "DEBUG",
      rateLimitKey,
      "PROVIDER_CALL_EXPECTED_EMPTY",
      baseLog,
      60000
    );
  } else if (!response.ok) {
    techLog(
      "PROVIDER_CALL_FAIL",
      sanitizeForLog({
        ...baseLog,
        allow,
        contentType,
        textLen,
      })
    );
  }

  if (!response.ok && !isExpected404 && canLog("DEBUG")) {
    let responseTopLevelKeys = null;

    if (data && typeof data === "object" && !Array.isArray(data)) {
      responseTopLevelKeys = Object.keys(data).slice(0, 20);
    }

    debugLog(
      "PROVIDER_BODY_METADATA",
      sanitizeForLog({
        ...baseLog,
        contentType,
        textLen,
        dataType: Array.isArray(data)
          ? "array"
          : data === null
            ? "null"
            : typeof data,
        responseTopLevelKeys,
      })
    );
  }

  if (response.status === 405 && canLog("DEBUG")) {
    try {
      const optionsResponse = await fetchWithTimeout(
        url,
        {
          method: "OPTIONS",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
          },
        },
        10000
      );

      const allow2 =
        optionsResponse.headers.get("allow") ||
        optionsResponse.headers.get("Allow") ||
        null;

      log(
        "DEBUG",
        "PROVIDER_OPTIONS",
        sanitizeForLog({
          ...baseLog,
          optionsStatus: optionsResponse.status,
          allow: allow2,
        })
      );
    } catch (e) {
      log(
        "DEBUG",
        "PROVIDER_OPTIONS",
        sanitizeForLog({
          ...baseLog,
          error: String(e?.message || e),
        })
      );
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
    rid: requestId,
    allow,
    contentType,
  };
}

async function safeProviderFetch(path, options = {}) {
  try {
    return await providerFetch(path, options);
  } catch (err) {
    throw normalizeProviderError(err, {
      endpoint: path,
    });
  }
}

export {
  mergeTraceMeta,
  providerFetch,
  safeProviderFetch,
  safeProviderFetch as versatilisFetch,
};
