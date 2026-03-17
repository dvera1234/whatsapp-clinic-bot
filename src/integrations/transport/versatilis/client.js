import crypto from "crypto";
import { debugLog, techLog } from "../../observability/audit.js";
import { canLog, log, logRateLimited } from "../../observability/logger.js";
import { fetchWithTimeout } from "../../utils/time.js";
import { versatilisGetToken } from "./auth.js";
import { sanitizeQueryForLog } from "./queryLog.js";

function readString(value) {
  const v = String(value ?? "").trim();
  return v || "";
}

function resolveVersatilisBaseUrl(tenantConfig = {}) {
  const base = readString(tenantConfig?.integrations?.versatilis?.baseUrl);
  if (!base) return "";
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function mergeTraceMeta(base, extra) {
  return {
    ...(base || {}),
    ...(extra || {}),
  };
}

async function versatilisFetch(
  path,
  {
    method = "GET",
    jsonBody,
    extraHeaders,
    traceMeta,
    tenantId,
    tenantConfig,
  } = {}
) {
  const rid = crypto.randomUUID();
  const baseUrl = resolveVersatilisBaseUrl(tenantConfig);

  if (!tenantId) {
    const err = new Error("tenantId ausente em versatilisFetch");
    err.code = "TENANT_ID_MISSING_IN_VERSATILIS_FETCH";
    throw err;
  }

  if (!baseUrl) {
    const err = new Error("Base URL do Versatilis ausente no tenantConfig");
    err.code = "VERSATILIS_BASE_URL_MISSING";
    throw err;
  }

  const token = await versatilisGetToken({ tenantId, tenantConfig });
  const url = `${baseUrl}${path}`;
  const t0 = Date.now();

  let query = null;
  try {
    const u = new URL(url);
    query = Object.fromEntries(u.searchParams.entries());
  } catch {
    // ignore
  }

  const safeQuery = sanitizeQueryForLog(query);

  const r = await fetchWithTimeout(
    url,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(jsonBody ? { "Content-Type": "application/json" } : {}),
        ...(extraHeaders ? extraHeaders : {}),
      },
      body: jsonBody ? JSON.stringify(jsonBody) : undefined,
    },
    15000
  );

  const ms = Date.now() - t0;
  const allow = r.headers.get("allow") || r.headers.get("Allow") || null;
  const contentType = r.headers.get("content-type") || null;

  const text = await r.text().catch(() => "");
  const textLen = text ? text.length : 0;

  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  const normalizedText =
    typeof data === "string" ? data.toLowerCase() : "";

  const isExpected404 =
    r.status === 404 &&
    (
      normalizedText.includes("não foram encontradas") ||
      normalizedText.includes("não foram encontrados") ||
      normalizedText.includes("usuário não encontrado") ||
      normalizedText.includes("agendamento não encontrado")
    );

  const technicalResult = r.ok
    ? "API_ACCEPTED"
    : isExpected404
    ? "EXPECTED_EMPTY_RESULT"
    : "API_REJECTED";

  const baseLog = {
    rid,
    method,
    path,
    status: r.status,
    ms,
    query: safeQuery,
    hasBody: !!jsonBody,
    technicalResult,
    ...(traceMeta ? traceMeta : {}),
    tenantId,
  };

  if (r.ok) {
    debugLog("VERSATILIS_CALL_OK", baseLog);
  } else if (isExpected404) {
    const rateLimitKey = `expected404:${tenantId}:${method}:${path.split("?")[0]}`;
    logRateLimited(
      "DEBUG",
      rateLimitKey,
      "VERSATILIS_CALL_EXPECTED_EMPTY",
      baseLog,
      60_000
    );
  } else {
    techLog("VERSATILIS_CALL_FAIL", {
      ...baseLog,
      allow,
      contentType,
      textLen,
    });
  }

  if (!r.ok && !isExpected404 && canLog("DEBUG")) {
    let responseTopLevelKeys = null;

    if (data && typeof data === "object" && !Array.isArray(data)) {
      responseTopLevelKeys = Object.keys(data).slice(0, 20);
    }

    debugLog("VERSATILIS_BODY_METADATA", {
      ...baseLog,
      contentType,
      textLen,
      dataType: Array.isArray(data)
        ? "array"
        : data === null
        ? "null"
        : typeof data,
      responseTopLevelKeys,
    });
  }

  if (r.status === 405 && canLog("DEBUG")) {
    try {
      const ro = await fetchWithTimeout(
        url,
        {
          method: "OPTIONS",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
        },
        10000
      );

      const allow2 = ro.headers.get("allow") || ro.headers.get("Allow") || null;

      log("DEBUG", "VERSATILIS_OPTIONS", {
        ...baseLog,
        optionsStatus: ro.status,
        allow: allow2,
      });
    } catch (e) {
      log("DEBUG", "VERSATILIS_OPTIONS", {
        ...baseLog,
        error: String(e?.message || e),
      });
    }
  }

  return { ok: r.ok, status: r.status, data, rid, allow, contentType };
}

export { mergeTraceMeta, versatilisFetch };
