import crypto from "crypto";
import { debugLog, techLog } from "../../../observability/audit.js";
import {
  canLog,
  log,
  logRateLimited,
} from "../../../observability/logger.js";
import { fetchWithTimeout } from "../../../utils/time.js";
import { sanitizeForLog } from "../../../utils/logSanitizer.js";
import { getProviderAccessToken } from "./auth.js";
import { sanitizeQueryForLog } from "./queryLog.js";

function readString(value) {
  const v = String(value ?? "").trim();
  return v || "";
}

function resolveProviderBaseUrl(runtime = {}, capability = null) {
  const byCapability = {
    identity: runtime?.integrations?.identity?.baseUrl,
    access: runtime?.integrations?.access?.baseUrl,
    booking: runtime?.integrations?.booking?.baseUrl,
  };

  if (capability) {
    const direct = readString(byCapability[capability]);
    if (direct) {
      return direct.endsWith("/") ? direct.slice(0, -1) : direct;
    }
  }

  const candidates = [
    runtime?.integrations?.identity?.baseUrl,
    runtime?.integrations?.access?.baseUrl,
    runtime?.integrations?.booking?.baseUrl,
  ];

  for (const candidate of candidates) {
    const base = readString(candidate);
    if (base) {
      return base.endsWith("/") ? base.slice(0, -1) : base;
    }
  }

  return "";
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

async function providerFetch(
  path,
  {
    method = "GET",
    jsonBody,
    extraHeaders,
    traceMeta,
    tenantId,
    runtime,
    capability = null,
  } = {}
) {
  const requestId = crypto.randomUUID();

  if (!tenantId) {
    const err = new Error("tenantId ausente em providerFetch");
    err.code = "TENANT_ID_MISSING";
    throw err;
  }

  if (!runtime || typeof runtime !== "object") {
    const err = new Error("runtime ausente em providerFetch");
    err.code = "RUNTIME_MISSING";
    throw err;
  }

  if (!capability) {
    const err = new Error("capability obrigatória em providerFetch");
    err.code = "CAPABILITY_REQUIRED";
    throw err;
  }
  
  const resolvedCapability = capability;
  
  const baseUrl = resolveProviderBaseUrl(runtime, resolvedCapability);

  if (!baseUrl) {
    const err = new Error("Base URL do provider ausente no runtime");
    err.code = "PROVIDER_BASE_URL_MISSING";
    throw err;
  }

  const accessToken = await getProviderAccessToken({
    tenantId,
    runtime,
    capability: resolvedCapability,
  });

  const url = `${baseUrl}${path}`;
  const startedAt = Date.now();

  let query = null;
  try {
    const u = new URL(url);
    query = Object.fromEntries(u.searchParams.entries());
  } catch {}

  const safeQuery = sanitizeQueryForLog(query);

  const response = await fetchWithTimeout(
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

  const durationMs = Date.now() - startedAt;

  const allow =
    response.headers.get("allow") || response.headers.get("Allow") || null;

  const contentType = response.headers.get("content-type") || null;

  const text = await response.text().catch(() => "");
  const textLen = text ? text.length : 0;

  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  const normalizedText = typeof data === "string" ? data.toLowerCase() : "";

  const isExpected404 =
    response.status === 404 &&
    (normalizedText.includes("não foram encontradas") ||
      normalizedText.includes("não foram encontrados") ||
      normalizedText.includes("usuário não encontrado") ||
      normalizedText.includes("agendamento não encontrado"));

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
    capability: resolvedCapability,
    ...(traceMeta || {}),
    tenantId,
  };

  const baseLog = sanitizeForLog(baseLogRaw);

  if (response.ok) {
   
  } else if (isExpected404) {
    const rateLimitKey = `expected404:${tenantId}:${method}:${safePath.split("?")[0]}`;

    logRateLimited(
      "DEBUG",
      rateLimitKey,
      "PROVIDER_CALL_EXPECTED_EMPTY",
      baseLog,
      60000
    );
  } else {
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

export {
  mergeTraceMeta,
  providerFetch,
  providerFetch as versatilisFetch,
};
