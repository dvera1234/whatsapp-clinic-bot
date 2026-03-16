import crypto from "crypto";
import { debugLog, techLog } from "../../observability/audit.js";
import { canLog, log, logRateLimited } from "../../observability/logger.js";
import { fetchWithTimeout } from "../../utils/time.js";
import { versatilisGetToken, VERSA_BASE } from "./auth.js";
import { sanitizeQueryForLog } from "./helpers.js";

function mergeTraceMeta(base, extra) {
  return {
    ...(base || {}),
    ...(extra || {}),
  };
}

async function versatilisFetch(path, { method = "GET", jsonBody, extraHeaders, traceMeta } = {}) {
  const token = await versatilisGetToken();

  const rid = crypto.randomUUID();
  const url = `${VERSA_BASE}${path}`;
  const t0 = Date.now();

  let query = null;
  try {
    const u = new URL(url);
    query = Object.fromEntries(u.searchParams.entries());
  } catch {}

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

  const isNoDates404 =
    r.status === 404 &&
    typeof data === "string" &&
    data.toLowerCase().includes("não foram encontradas datas disponiveis");

  const technicalResult =
    r.ok ? "API_ACCEPTED" :
    isNoDates404 ? "EXPECTED_EMPTY_RESULT" :
    "API_REJECTED";

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
  };

  if (r.ok) {
    debugLog("VERSATILIS_CALL_OK", baseLog);
  } else if (isNoDates404) {
    const rateLimitKey = `nodates:${method}:${path.split("?")[0]}`;
    logRateLimited("DEBUG", rateLimitKey, "VERSATILIS_CALL_EXPECTED_EMPTY", baseLog, 60_000);
  } else {
    techLog("VERSATILIS_CALL_FAIL", {
      ...baseLog,
      allow,
      contentType,
      textLen,
    });
  }

  if (!r.ok && !isNoDates404 && canLog("DEBUG")) {
    let responseTopLevelKeys = null;

    if (data && typeof data === "object" && !Array.isArray(data)) {
      responseTopLevelKeys = Object.keys(data).slice(0, 20);
    }

    debugLog("VERSATILIS_BODY_METADATA", {
      ...baseLog,
      contentType,
      textLen,
      dataType:
        Array.isArray(data) ? "array" :
        data === null ? "null" :
        typeof data,
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

  return { ok: r.ok, status: r.status, data, rid, allow };
}

export {
  mergeTraceMeta,
  versatilisFetch,
};
