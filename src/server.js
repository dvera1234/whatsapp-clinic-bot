import express from "express";
import crypto from "crypto";

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: "256kb" }));

function md5Hex(s) {
  return crypto.createHash("md5").update(String(s), "utf8").digest("hex");
}

function generateTempPassword(len = 10) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

import { getRedisClient } from "./redis.js";

// ✅ Redis singleton (uma conexão por processo)
const redis = getRedisClient();

// =======================
// LOGGING (níveis + rate limit simples)
// =======================
const LOG_LEVEL = String(process.env.LOG_LEVEL || "INFO").toUpperCase();
// DEBUG < INFO < WARN < ERROR
const LOG_RANK = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
function canLog(level) {
  const want = LOG_RANK[String(level || "INFO").toUpperCase()] ?? 20;
  const have = LOG_RANK[LOG_LEVEL] ?? 20;
  return want >= have;
}

function log(level, tag, obj) {
  if (!canLog(level)) return;
  const payload = obj ? ` ${safeJson(obj)}` : "";
  safeConsoleWrite(`[${nowIso()}] [${level}] ${tag}${payload}`);
}

// JSON seguro (sem quebrar log por circular)
function safeJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return JSON.stringify({ note: "unstringifiable" });
  }
}

function nowIso() {
  return new Date().toISOString();
}

function baseAuditPayload(event, payload = {}) {
  return {
    event,
    ...payload,
  };
}

function safeConsoleWrite(line) {
  try {
    console.log(line);
  } catch (e) {
    try {
      console.error("[LOGGER_FAIL]", String(e?.message || e));
    } catch {}
  }
}

function writeLog(tag, event, payload = {}) {
  const ts = nowIso();
  safeConsoleWrite(`[${ts}] [${tag}] ${safeJson(baseAuditPayload(event, payload))}`);
}

function audit(event, payload = {}) {
  writeLog("AUDIT", event, payload);
}

function techLog(event, payload = {}) {
  if (!canLog("WARN")) return;
  writeLog("TECH", event, payload);
}

function opLog(event, payload = {}) {
  writeLog("OP", event, payload);
}

function errLog(event, payload = {}) {
  writeLog("ERROR", event, payload);
}

function debugLog(event, payload = {}) {
  if (!canLog("DEBUG")) return;
  writeLog("DEBUG", event, payload);
}

opLog("BUILD_INFO", { build: "2026-02-21T20:05 ALTERARUSUARIO-POST" });

// rate limit de logs repetidos (em memória) — bom p/ 404 de agenda
// key -> { lastMs, count }
const _logRL = new Map();

function logRateLimited(level, key, tag, obj, minIntervalMs = 60_000) {
  const now = Date.now();
  const prev = _logRL.get(key);

  if (prev && now - prev.lastMs < minIntervalMs) {
    prev.count++;
    _logRL.set(key, prev);
    return;
  }

  const suppressedCount = prev?.count || 0;

  _logRL.set(key, { lastMs: now, count: 0 });

  const payload =
    suppressedCount > 0
      ? { ...(obj || {}), suppressedCountSinceLastLog: suppressedCount }
      : obj;

  log(level, tag, payload);
}

// =====================================
// PLANOS FIXOS 
// =====================================
const COD_PLANO_PARTICULAR = 2;
const COD_PLANO_MEDSENIOR_SP = 3;

const PLAN_KEYS = {
  PARTICULAR: "PARTICULAR",
  MEDSENIOR_SP: "MEDSENIOR_SP",
};

function resolveCodPlano(planoKey) {
  return planoKey === PLAN_KEYS.MEDSENIOR_SP ? COD_PLANO_MEDSENIOR_SP : COD_PLANO_PARTICULAR;
}

// =======================
// PLANOS: detectar/normalizar (Versatilis -> session)
// =======================
function normalizePlanListFromProfile(profile) {
  const list = [];

  // CodPlanos pode vir como array
  if (Array.isArray(profile?.CodPlanos)) {
    for (const x of profile.CodPlanos) {
      const n = parsePositiveInt(x);
      if (n) list.push(n);
    }
  }

  // CodPlano pode vir como string/number
  const one = parsePositiveInt(profile?.CodPlano);
  if (one) list.push(one);

  // unique
  return Array.from(new Set(list));
}

function planKeyFromCodPlano(codPlano) {
  const n = Number(codPlano);
  if (n === COD_PLANO_MEDSENIOR_SP) return PLAN_KEYS.MEDSENIOR_SP;
  if (n === COD_PLANO_PARTICULAR) return PLAN_KEYS.PARTICULAR;
  return null; // desconhecido
}

function codPlanoFromPlanKey(planKey) {
  return resolveCodPlano(planKey);
}

function hasPlanKey(plansCodList, planKey) {
  const want = codPlanoFromPlanKey(planKey);
  return (plansCodList || []).some((x) => Number(x) === Number(want));
}

// =======================
// VERSATILIS (fetch) — helper mínimo e seguro
// =======================
const VERSA_BASE_RAW = process.env.VERSATILIS_BASE || ""; // deve ser só a raiz do cliente (SEM /api)
const VERSA_USER = process.env.VERSATILIS_USER;
const VERSA_PASS = process.env.VERSATILIS_PASS;

function sanitizeVersaBase(u) {
  let s = String(u).trim();

  // remove espaços e barras finais
  s = s.replace(/\s+/g, "");
  s = s.replace(/\/+$/, "");

  // se alguém colar /api/... no ENV, corta fora
  s = s.replace(/\/api\/.*$/i, "");

  // se alguém colar /api no fim, remove também
  s = s.replace(/\/api$/i, "");

  return s;
}

const VERSA_BASE = sanitizeVersaBase(VERSA_BASE_RAW);

function maskUrl(u) {
  const s = String(u || "");
  if (!s) return "";
  // mantém domínio + 1º segmento e mascara o resto
  try {
    const url = new URL(s);
    const parts = url.pathname.split("/").filter(Boolean);
    const keep = parts.slice(0, 1).join("/");
    return `${url.origin}/${keep}/***`;
  } catch {
    return "***";
  }
}

opLog("VERSATILIS_BASE_CONFIG", {
  raw: maskUrl(VERSA_BASE_RAW),
  sanitized: maskUrl(VERSA_BASE),
});

let versaToken = null;
let versaTokenExpMs = 0;

function maskToken(t) {
  if (!t || typeof t !== "string") return "***";
  return t.length > 16 ? `${t.slice(0, 6)}...${t.slice(-4)}` : "***";
}

async function versatilisGetToken() {
  const now = Date.now();
  if (versaToken && now < versaTokenExpMs - 30_000) return versaToken; // margem 30s

  if (!VERSA_BASE || !VERSA_USER || !VERSA_PASS) {
    throw new Error("Versatilis ENV ausente (VERSATILIS_BASE/USER/PASS).");
  }

  const body = new URLSearchParams({
    username: VERSA_USER,
    password: VERSA_PASS,
    grant_type: "password",
  });

  const r = await fetch(`${VERSA_BASE}/Token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`Versatilis Token falhou status=${r.status}`);
  }

  versaToken = json.access_token;
  const exp = Number(json.expires_in || 0);
  versaTokenExpMs = Date.now() + Math.max(60, exp) * 1000;

  opLog("VERSATILIS_TOKEN_REFRESH_OK", { token: maskToken(versaToken) });
  return versaToken;
}

function maskLoginValue(v) {
  const s = String(v || "").trim();
  if (!s) return "";

  if (s.includes("@")) {
    const [user, domain] = s.split("@");
    const u = user.length <= 2 ? "***" : `${user.slice(0, 2)}***`;
    return `${u}@${domain || "***"}`;
  }

  const digits = s.replace(/\D+/g, "");
  if (digits.length >= 6) {
    return `${digits.slice(0, 2)}***${digits.slice(-2)}`;
  }

  return "***";
}

function sanitizeQueryForLog(queryObj) {
  if (!queryObj || typeof queryObj !== "object") return null;

  const out = {};
  for (const [k, v] of Object.entries(queryObj)) {
    const key = String(k || "").toLowerCase();

    if (key === "login") {
      out[k] = maskLoginValue(v);
      continue;
    }

    if (key === "dtnasc" || key === "datanascimento" || key === "usercpf" || key === "cpf") {
      out[k] = "***";
      continue;
    }

    out[k] = v;
  }

  return out;
}

function mergeTraceMeta(base, extra) {
  return {
    ...(base || {}),
    ...(extra || {}),
  };
}

function auditOutcome(payload = {}) {
  return {
    ...payload,
    traceId: payload.traceId || null,
    tracePhone: payload.tracePhone || null,
    rid: payload.rid || null,
    httpStatus: payload.httpStatus ?? null,
    technicalAccepted: !!payload.technicalAccepted,
    functionalResult: payload.functionalResult || null,
    patientFacingMessage: payload.patientFacingMessage || null,
    escalationRequired: !!payload.escalationRequired,
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

  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(jsonBody ? { "Content-Type": "application/json" } : {}),
      ...(extraHeaders ? extraHeaders : {}),
    },
    body: jsonBody ? JSON.stringify(jsonBody) : undefined,
  });

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
    const preview =
      typeof data === "string"
        ? data.slice(0, 500)
        : data == null
        ? null
        : JSON.stringify(data).slice(0, 500);

    debugLog("VERSATILIS_BODY_PREVIEW", {
      ...baseLog,
      contentType,
      textLen,
      preview: preview || "[empty-body]",
    });
  }

  if (r.status === 405 && canLog("DEBUG")) {
    try {
      const ro = await fetch(url, {
        method: "OPTIONS",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
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

function formatCPFMask(cpf11) {
  const c = String(cpf11 || "").replace(/\D+/g, "");
  if (c.length !== 11) return null;
  return `${c.slice(0,3)}.${c.slice(3,6)}.${c.slice(6,9)}-${c.slice(9,11)}`;
}

function parsePositiveInt(v) {
  if (v == null) return null;

  if (typeof v === "number") {
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  if (typeof v === "string") {
    const s = v.trim().replace(/^"+|"+$/g, "");
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  return null;
}

function findCodUsuarioDeep(obj, depth = 0, maxDepth = 6, seen = new Set()) {
  if (obj == null) return null;

  // tenta direto se for number/string
  const direct = parsePositiveInt(obj);
  if (direct) return direct;

  if (typeof obj !== "object") return null;
  if (seen.has(obj)) return null;
  seen.add(obj);

  if (depth > maxDepth) return null;

  // Se for array, varre itens
  if (Array.isArray(obj)) {
    for (const it of obj) {
      const found = findCodUsuarioDeep(it, depth + 1, maxDepth, seen);
      if (found) return found;
    }
    return null;
  }

  // Se for objeto, tenta achar chaves que “parecem” CodUsuario
  for (const [k, v] of Object.entries(obj)) {
    const key = String(k || "").toLowerCase();

    // pega variantes comuns (bem permissivo)
    if (key === "codusuario" || key === "codigoUsuario".toLowerCase() || key.includes("codusuario")) {
      const n = parsePositiveInt(v);
      if (n) return n;
      const deep = findCodUsuarioDeep(v, depth + 1, maxDepth, seen);
      if (deep) return deep;
    }
  }

  // Se não achou por chave, varre tudo (fallback)
  for (const v of Object.values(obj)) {
    const found = findCodUsuarioDeep(v, depth + 1, maxDepth, seen);
    if (found) return found;
  }

  return null;
}

function parseCodUsuarioFromAny(data) {
  return findCodUsuarioDeep(data);
}

async function versaFindCodUsuarioByCPF(cpfDigits) {
  const cpf = String(cpfDigits || "").replace(/\D+/g, "");
  if (cpf.length !== 11) return null;

  const cpfMask = formatCPFMask(cpf);

  // tenta variações comuns (CPF vs cpf) e CPF formatado
  const candidates = [
    `/api/Login/CodUsuario?CPF=${encodeURIComponent(cpf)}`,
    `/api/Login/CodUsuario?cpf=${encodeURIComponent(cpf)}`,
    cpfMask ? `/api/Login/CodUsuario?CPF=${encodeURIComponent(cpfMask)}` : null,
    cpfMask ? `/api/Login/CodUsuario?cpf=${encodeURIComponent(cpfMask)}` : null,
  ].filter(Boolean);

  for (const path of candidates) {
    const out = await versatilisFetch(path);

        // DEBUG de estrutura (não imprime valores)
if (process.env.DEBUG_VERSA_SHAPE === "1" && out.ok && out.data && typeof out.data === "object") {
  const keys = Object.keys(out.data || {}).slice(0, 30);
  debugLog("VERSA_CODUSUARIO_SHAPE", { path, keys, isArray: Array.isArray(out.data) });
}
    
    const parsed = out.ok ? parseCodUsuarioFromAny(out.data) : null;

  debugLog("VERSA_CODUSUARIO_LOOKUP_ATTEMPT", {
    technicalAccepted: out.ok,
    httpStatus: out.status,
    path,
    parsedResult: parsed ? "FOUND" : "NOT_FOUND",
  });

    if (!parsed) {
      debugLog("VERSA_CODUSUARIO_LOOKUP_DETAIL", {
        path,
        httpStatus: out.status,
        dataType: typeof out.data,
        dataPreview:
          typeof out.data === "string"
            ? out.data.slice(0, 80)
            : Array.isArray(out.data)
            ? "array"
            : out.data
            ? "object"
            : "null",
      });
    }

    if (parsed) return parsed;
  }

  return null;
}

async function versaFindCodUsuarioByDadosCPF(cpfDigits) {
  const cpf = String(cpfDigits || "").replace(/\D+/g, "");
  if (cpf.length !== 11) return null;

  const cpfMask = formatCPFMask(cpf);

  const candidates = [
    cpfMask ? `/api/Login/DadosUsuarioPorCPF?UserCPF=${encodeURIComponent(cpfMask)}` : null,
    `/api/Login/DadosUsuarioPorCPF?UserCPF=${encodeURIComponent(cpf)}`,
  ].filter(Boolean);

  for (const path of candidates) {
    const out = await versatilisFetch(path);
    const parsed = out.ok ? parseCodUsuarioFromAny(out.data) : null;

  debugLog("VERSA_DADOSUSUARIOPORCPF_LOOKUP_ATTEMPT", {
    technicalAccepted: out.ok,
    httpStatus: out.status,
    path,
    parsedResult: parsed ? "FOUND" : "NOT_FOUND",
  });

    if (!parsed) {
      debugLog("VERSA_DADOSUSUARIOPORCPF_LOOKUP_DETAIL", {
        path,
        httpStatus: out.status,
        dataType: typeof out.data,
      });
    }

    if (parsed) return parsed;
  }

  return null;
}

async function versaGetDadosUsuarioPorCodigo(codUsuario) {
  const id = Number(codUsuario);
  if (!Number.isFinite(id) || id <= 0) return { ok: false, data: null };

  const out = await versatilisFetch(
  `/api/Login/DadosUsuarioPorCodigo?CodUsuario=${encodeURIComponent(id)}`,
  {
    traceMeta: {
      flow: "DADOS_USUARIO_CODIGO",
      codUsuario: id
    }
  }
);
  if (!out.ok || !out.data) return { ok: false, data: null };

  return { ok: true, data: out.data };
}

function isValidEmail(s) {
  const t = String(s || "").trim();
  return t.length >= 6 && t.includes("@") && t.includes(".");
}

function normalizeCEP(s) {
  return String(s || "").replace(/\D+/g, "");
}

function parseBRDateToISO(br) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(br || "").trim());
  if (!m) return null;
  const dd = Number(m[1]), mm = Number(m[2]), yyyy = Number(m[3]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${yyyy}-${String(mm).padStart(2,"0")}-${String(dd).padStart(2,"0")}`;
}

function formatBRDateFromISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return null;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

// =======================
// RESET SENHA (manual-first + divergência)
// Manual: GET /api/Login/SolicitarSenha?login={login}&dtNasc={dataNascimento}
// Observado no tenant: POST => 405 Allow: GET (então manter somente GET)
// Divergência registrada se o tenant rejeitar o manual (400/404) mesmo com dataNascimento
// =======================
function previewOutData(out) {
  const d = out?.data;
  if (d == null) return null;
  if (typeof d === "string") return d.slice(0, 240);
  try {
    return JSON.stringify(d).slice(0, 240);
  } catch {
    return "[unstringifiable]";
  }
}

// ✅ FUNÇÃO QUE ESTAVA FALTANDO (ou foi quebrada)
// Tudo que estava “solto” agora fica aqui dentro.
async function versaSolicitarSenha({ login, dtNascISO, traceMeta = {} }) {
  const lg = String(login || "").trim();

  const dataBR = formatBRDateFromISO(dtNascISO);
  const dataISO = String(dtNascISO || "").trim();

  if (!lg || !dataBR || !dataISO) {
    return { ok: false, stage: "missing_login_or_dtnasc" };
  }

  const attempts = [
    { param: "dtNasc", value: dataISO },
  ];

  for (const a of attempts) {
    const path =
      `/api/Login/SolicitarSenha?login=${encodeURIComponent(lg)}` +
      `&${a.param}=${encodeURIComponent(a.value)}`;

    const out = await versatilisFetch(path, {
      method: "GET",
      traceMeta: mergeTraceMeta(traceMeta, {
        flow: "SOLICITAR_SENHA",
        loginMasked: maskLoginValue(lg),
        dtNascMasked: "***",
      }),
    });

  debugLog("RESET_PASSWORD_API_ATTEMPT", {
    method: "GET",
    path: "/api/Login/SolicitarSenha",
    param: a.param,
    loginMasked: maskLoginValue(lg),
    technicalAccepted: out.ok,
    httpStatus: out.status,
    rid: out.rid,
    preview: out.ok ? null : (previewOutData(out) || "[empty-or-nonjson-body]"),
    allow: out.allow || null,
    ...(traceMeta || {}),
  });

    if (out.ok) {
  return {
    ok: true,
    out,
    usedParam: a.param,
    usedValue: a.value,
    traceMeta: mergeTraceMeta(traceMeta, {
      loginMasked: maskLoginValue(lg),
    }),
  };
}

    if (![404, 400, 422].includes(out.status)) {
      return { ok: false, stage: "http_error", out, usedParam: a.param, usedValue: a.value };
    }
  }

  return {
    ok: false,
    stage: "no_matching_action_or_bad_date_format",
    hint:
      "A action existe para dtNasc (DateTime), mas o servidor não aceitou o formato. " +
      "Mantivemos tentativas ISO; se persistir 400, precisamos confirmar o formato exato exigido pelo tenant.",
  };
}

function detectLoginKind(login, cpfDigits, cpfMask, codUsuario, codUsuarioPad, email) {
  const lg = String(login || "");

  if (isValidEmail(lg)) return "email";
  if (codUsuarioPad && lg === String(codUsuarioPad)) return "codUsuarioPad";
  if (codUsuario && lg === String(codUsuario)) return "codUsuario";
  if (cpfDigits && lg === String(cpfDigits)) return "cpf";
  if (cpfMask && lg === String(cpfMask)) return "cpfMask";

  return "unknown";
}

async function versaSolicitarSenhaPorCPF(cpfDigits, dtNascISO, traceMeta = {}) {
  const cpf = String(cpfDigits || "").replace(/\D+/g, "");
  if (cpf.length !== 11) return { ok: false, stage: "cpf_invalid" };

  const cpfMask = formatCPFMask(cpf);

  const codUsuario =
    (await versaFindCodUsuarioByCPF(cpf)) ||
    (await versaFindCodUsuarioByDadosCPF(cpf));

  let email = "";
  if (codUsuario) {
    const prof = await versaGetDadosUsuarioPorCodigo(codUsuario);
    email = prof.ok ? cleanStr(prof.data?.Email) : "";
  }

  let codUsuarioPad = null;
  if (codUsuario) {
    const codStr = String(codUsuario);
    codUsuarioPad = codStr.padStart(10, "0");
  }

  const localTraceMeta = mergeTraceMeta(traceMeta, {
    cpfMasked: "***",
    codUsuario: codUsuario || null,
    codUsuarioPad: codUsuarioPad || null,
  });

  const logins = [
    codUsuarioPad,
    codUsuario ? String(codUsuario) : null,
    isValidEmail(email) ? email : null,
    cpf,
    cpfMask || null,
  ].filter(Boolean);

   for (const lg of logins) {
    const loginKind = detectLoginKind(lg, cpf, cpfMask, codUsuario, codUsuarioPad, email);

    const out = await versaSolicitarSenha({
      login: lg,
      dtNascISO,
      traceMeta: mergeTraceMeta(localTraceMeta, {
        loginKind,
      }),
    });

  debugLog("RESET_PASSWORD_LOGIN_VARIANT_ATTEMPT", {
    loginKind,
    loginMasked: maskLoginValue(lg),
    technicalAccepted: out.ok,
    technicalStage: out.stage,
    httpStatus: out?.out?.status,
    rid: out?.out?.rid,
    ...(traceMeta || {}),
  });

    if (out.ok) {
  return {
    ...out,
    loginKind,
    traceMeta: mergeTraceMeta(out.traceMeta, {
      loginKind,
      loginMasked: maskLoginValue(lg),
    }),
  };
}

    if (out?.out?.status && ![400, 404, 422, 500].includes(out.out.status)) {
      return out;
    }
  }

  return { ok: false, stage: "all_login_variants_failed" };
}

// =======================
// REGRA 30 DIAS (RETORNO)
// =======================
async function versaHadAppointmentLast30Days(codUsuario, traceMeta = {}) {
  if (!codUsuario) return false;

  const out = await versatilisFetch(
    `/api/Agendamento/HistoricoAgendamento?codUsuario=${encodeURIComponent(codUsuario)}`,
    {
      traceMeta: mergeTraceMeta(traceMeta, {
        flow: "RETURN_CHECK_LAST_30_DAYS",
        codUsuario: Number(codUsuario) || null,
      }),
    }
  );

  if (!out.ok || !Array.isArray(out.data)) {
    audit("RETURN_CHECK_HISTORY_UNAVAILABLE", auditOutcome({
      ...traceMeta,
      codUsuario: Number(codUsuario) || null,
      technicalAccepted: !!out?.ok,
      httpStatus: out?.status || null,
      rid: out?.rid || null,
      functionalResult: "RETURN_CHECK_UNAVAILABLE",
      patientFacingMessage: null,
      escalationRequired: false,
    }));
    return false;
  }

  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  for (const ag of out.data) {
    if (!ag?.Data) continue;

    const parts = ag.Data.split("/");
    if (parts.length !== 3) continue;

    const [dd, mm, yyyy] = parts;
    const dateMs = new Date(`${yyyy}-${mm}-${dd}T00:00:00-03:00`).getTime();

    if (!Number.isFinite(dateMs)) continue;

    if (now - dateMs <= THIRTY_DAYS_MS) {
      audit("RETURN_CHECK_POSITIVE_LAST_30_DAYS", auditOutcome({
        ...traceMeta,
        codUsuario: Number(codUsuario) || null,
        technicalAccepted: true,
        functionalResult: "RETURN_CHECK_POSITIVE",
        patientFacingMessage: null,
        escalationRequired: false,
      }));
      return true;
    }
  }

  audit("RETURN_CHECK_NEGATIVE_LAST_30_DAYS", auditOutcome({
    ...traceMeta,
    codUsuario: Number(codUsuario) || null,
    technicalAccepted: true,
    functionalResult: "RETURN_CHECK_NEGATIVE",
    patientFacingMessage: null,
    escalationRequired: false,
    historyCount: out.data.length,
  }));

  return false;
}

function cleanStr(s) { return String(s ?? "").trim(); }

function validatePortalCompleteness(profile) {
  const missing = [];

  const Nome = cleanStr(profile?.Nome);
  const CPF = cleanStr(profile?.CPF).replace(/\D+/g, "");
  const Email = cleanStr(profile?.Email);
  const Celular = cleanStr(profile?.Celular).replace(/\D+/g, "");
  const CEP = cleanStr(profile?.CEP).replace(/\D+/g, "");
  const Endereco = cleanStr(profile?.Endereco);
  const Numero = cleanStr(profile?.Numero);
  const Bairro = cleanStr(profile?.Bairro);
  const Cidade = cleanStr(profile?.Cidade);
  const Complemento = cleanStr(profile?.Complemento);

  // DtNasc às vezes vem ISO com hora; se vier vazio, cobra no wizard
  const DtNasc = cleanStr(profile?.DtNasc);

  if (!Nome) missing.push("nome completo");
  if (CPF.length !== 11) missing.push("CPF");
  if (!isValidEmail(Email)) missing.push("e-mail");
  if (Celular.length < 10) missing.push("celular");
  if (CEP.length !== 8) missing.push("CEP");
  if (!Endereco) missing.push("endereço");
  if (!Numero) missing.push("número");
  if (!Bairro) missing.push("bairro");
  if (!Cidade) missing.push("cidade");
  if (!DtNasc) missing.push("data de nascimento");

  // UF não existe no manual como campo próprio: vamos exigir e salvar em Complemento como "UF:XX"
  const hasUF = /\bUF:\s*[A-Z]{2}\b/.test(Complemento.toUpperCase());
  if (!hasUF) missing.push("estado (UF)");

  return { ok: missing.length === 0, missing };
}

function mergeComplementoWithUF(complementoUser, uf) {
  const c = cleanStr(complementoUser);
  const U = cleanStr(uf).toUpperCase();
  const base = `UF:${U}`;
  if (!c || c === "0") return base;
  // evita duplicar
  if (c.toUpperCase().includes("UF:")) return c;
  return `${base} | ${c}`;
}

async function versaUpsertPortalCompleto({ existsCodUsuario, form, traceMeta = {} }) {
  // form: { nome, cpf, dtNascISO, sexoOpt, celular, email, cep, endereco, numero, complemento, bairro, cidade, uf, planoKey }
  const planoKey = form.planoKey;
  const codPlano = resolveCodPlano(planoKey);

  const tempPass = generateTempPassword(10);
  const senhaMD5 = md5Hex(tempPass);

  const dtNascBR = formatBRDateFromISO(form.dtNascISO); // DD/MM/AAAA

  // payload base
  const payload = {
    Nome: form.nome,
    CPF: form.cpf,
    Email: form.email,
    DtNasc: dtNascBR,
    Celular: form.celular,
    Telefone: form.telefone || form.celular || "",
    CEP: form.cep,
    Endereco: form.endereco,
    Numero: form.numero,
    Complemento: mergeComplementoWithUF(form.complemento, form.uf),
    Bairro: form.bairro,
    Cidade: form.cidade,
    CodPlano: String(codPlano),
    CodPlanos: [codPlano],
  };

  if (form.sexoOpt === "M" || form.sexoOpt === "F") {
    payload.Sexo = form.sexoOpt;
  }

  // ✅ Só define senha quando for CADASTRO novo
  if (!existsCodUsuario) {
    payload.Senha = senhaMD5;
  }

  // ✅ Para ALTERAR, inclua CodUsuario no body
  if (existsCodUsuario) {
    payload.CodUsuario = Number(existsCodUsuario);
  }

  // ============================
  // 🔎 DEBUG SEGURO: mostra quais campos estão vazios
  // (não imprime valores!)
  // ============================
  function isEmpty(v) {
    if (v == null) return true;
    if (typeof v === "string") return v.trim().length === 0;
    if (Array.isArray(v)) return v.length === 0;
    return false;
  }

  const empties = Object.entries(payload)
    .filter(([k, v]) => isEmpty(v))
    .map(([k]) => k);

  const shape = Object.fromEntries(
    Object.entries(payload).map(([k, v]) => {
      if (typeof v === "string") return [k, `string(len=${v.length})`];
      if (typeof v === "number") return [k, "number"];
      if (Array.isArray(v)) return [k, `array(len=${v.length})`];
      if (typeof v === "boolean") return [k, "boolean"];
      return [k, typeof v];
    })
  );

  debugLog("PORTAL_UPSERT_PAYLOAD_SHAPE", {
    hasCodUsuario: !!payload.CodUsuario,
    empties,
    shape,
  });

  // 🔒 Bloqueio: não chama Versatilis com payload inválido
  if (empties.length > 0 || typeof payload.DtNasc !== "string" || payload.DtNasc.trim().length < 8) {
    audit("PORTAL_UPSERT_BLOCKED_INVALID_PAYLOAD", auditOutcome({
      ...traceMeta,
      technicalAccepted: false,
      functionalResult: "PORTAL_UPSERT_BLOCKED_INVALID_PAYLOAD",
      patientFacingMessage: null,
      escalationRequired: true,
      hasForm: !!form,
      formKeys: form ? Object.keys(form).sort() : [],
      formShape: form
        ? Object.fromEntries(
            Object.entries(form).map(([k, v]) => {
              if (v == null) return [k, "null/undefined"];
              if (typeof v === "string") return [k, `string(len=${v.length})`];
              if (typeof v === "number") return [k, "number"];
              if (typeof v === "boolean") return [k, "boolean"];
              if (Array.isArray(v)) return [k, `array(len=${v.length})`];
              return [k, typeof v];
            })
          )
        : {},
      missingFields: empties,
    }));

    return {
      ok: false,
      stage: "blocked_missing_fields",
      missing: empties,
      hint: "Wizard não preencheu dados obrigatórios. Corrigir fluxo WZ_*.",
    };
  }

    let out;

  // ======= TENTA ALTERAR (se existir) =======
  if (existsCodUsuario) {
    const route = await resolveVersaUpdateRoute(payload);

    if (!route) {
      return {
        ok: false,
        stage: "alterar_sem_rota",
        out: {
          ok: false,
          status: 0,
          rid: null,
          allow: null,
          data: "Não foi possível resolver endpoint/método de atualização (probe falhou).",
        },
      };
    }

    out = await versatilisFetch(route.path, {
      method: route.method,
      jsonBody: payload,
      traceMeta: mergeTraceMeta(traceMeta, {
        flow: "PORTAL_USER_UPDATE",
        codUsuario: Number(existsCodUsuario),
        cpfMasked: "***",
      }),
    });

    if (out.ok) return { ok: true, codUsuario: Number(existsCodUsuario) };

    // se falhou, não faz fallback de cadastro (você já confirmou que dá 400 "já existe")
    return { ok: false, stage: "alterar_falhou", out, resolved: route };
  }

  // ======= CADASTRO NOVO =======
  out = await versatilisFetch("/api/Login/CadastrarUsuario", {
  method: "POST",
  jsonBody: payload,
  traceMeta: mergeTraceMeta(traceMeta, {
    flow: "PORTAL_USER_CREATE",
    cpfMasked: "***",
  }),
});

 audit("PORTAL_USER_CREATE_ATTEMPT", auditOutcome({
  ...traceMeta,
  technicalAccepted: out.ok,
  httpStatus: out.status,
  rid: out.rid,
  functionalResult: out.ok ? "PORTAL_USER_CREATED" : "PORTAL_USER_CREATE_FAILED",
  patientFacingMessage: null,
  escalationRequired: !out.ok,
  dataType: typeof out.data,
}));

  if (!out.ok) return { ok: false, stage: "cadastrar", out };

  const codUsuario =
    parseCodUsuarioFromAny(out.data) ||
    Number(out?.data?.CodUsuario ?? out?.data?.codUsuario);

  return { ok: true, codUsuario: Number.isFinite(Number(codUsuario)) ? Number(codUsuario) : null };
}

// =======================
// ENV (robusto)
// =======================
function pickToken() {
  return (
    process.env.WHATSAPP_TOKEN ||
    process.env.META_TOKEN ||
    process.env.ACCESS_TOKEN ||
    process.env.FB_TOKEN ||
    process.env.GRAPH_TOKEN ||
    process.env.PERMANENT_TOKEN ||
    ""
  );
}

function pickPhoneNumberId(fallbackFromWebhook) {
  return (
    process.env.WHATSAPP_PHONE_NUMBER_ID ||
    process.env.PHONE_NUMBER_ID ||
    process.env.WA_PHONE_NUMBER_ID ||
    fallbackFromWebhook ||
    ""
  );
}

opLog("ENV_CHECK", {
  hasToken: !!pickToken(),
  hasVerifyToken: !!process.env.VERIFY_TOKEN,
  hasFlowResetCode: !!String(process.env.FLOW_RESET_CODE || "").trim(),
  flowResetCodeLen: String(process.env.FLOW_RESET_CODE || "").trim().length,
});

// =======================
// CONFIG
// =======================
const INACTIVITY_MS = 10 * 60 * 1000; // mantemos por enquanto (será revisado)
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 900); // 15 min (900s)

  // =======================
// DEBUG REDIS (controla logs de GET/SET)
// =======================
const DEBUG_REDIS = String(process.env.DEBUG_REDIS || "0").trim() === "1";

function logRedis(tag, obj) {
  if (!DEBUG_REDIS) return;
  console.log(`[${tag}]`, obj);
}
  
// =======================
// VERSATILIS FIXOS (via ENV) — NÃO hardcode
// =======================
function readPositiveIntEnv(name, fallback) {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// mover configs para ENV (como regra)
const COD_UNIDADE = readPositiveIntEnv("COD_UNIDADE", 2);
const COD_ESPECIALIDADE = readPositiveIntEnv("COD_ESPECIALIDADE", 1003);
const COD_COLABORADOR = readPositiveIntEnv("COD_COLABORADOR", 3);

// =======================
// RESET DE FLUXO (código secreto de teste)
// =======================
const FLOW_RESET_CODE = String(process.env.FLOW_RESET_CODE || "").trim(); 
// exemplo de ENV: FLOW_RESET_CODE="#menu123"

// Sessão 100% Redis (uma chave por telefone)
function sessionKey(phone) {
  return `sess:${String(phone || "").replace(/\D+/g, "")}`;
}

async function loadSession(phone) {
  const key = sessionKey(phone);
  logRedis("REDIS_GET", { phone: maskPhone(phone), key: maskKey(key) });

  const raw = await redis.get(key);

  // Upstash pode devolver string ou null
  if (raw == null) return null;

  // Se por algum motivo vier objeto, retorna direto (sem JSON.parse)
  if (typeof raw === "object") return raw;

  // Se vier string
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch (e) {
      errLog("REDIS_SESSION_CORRUPTED", {
        phoneMasked: maskPhone(phone),
        keyMasked: maskKey(key),
        error: String(e?.message || e),
      });
      await redis.del(key);
      return null;
    }
  }

  // fallback seguro
  return null;
}

async function saveSession(phone, sessionObj) {
  const key = sessionKey(phone);
  const val = JSON.stringify(sessionObj);

  logRedis("REDIS_SET", { phone: maskPhone(phone), key: maskKey(key), len: val.length });

  // Upstash: options object
  await redis.set(key, val, { ex: SESSION_TTL_SECONDS });
  return true;
}

async function deleteSession(phone) {
  const key = sessionKey(phone);
  await redis.del(key);
}

async function ensureSession(phone) {
  return (
    (await loadSession(phone)) || {
      state: null,
      lastUserTs: 0,
      lastPhoneNumberIdFallback: "",
      booking: null,
      portal: null,
      pending: null,
    }
  );
}

async function updateSession(phone, updater) {
  const s = await ensureSession(phone);
  await updater(s);
  await saveSession(phone, s);
  return s;
}

async function touchUser(phone, phoneNumberIdFallback) {
  return await updateSession(phone, (s) => {
    s.lastUserTs = Date.now();
    if (phoneNumberIdFallback) s.lastPhoneNumberIdFallback = phoneNumberIdFallback;
  });
}

async function setState(phone, state) {
  return await updateSession(phone, (s) => {
    s.state = state;
  });
}

async function getState(phone) {
  const s = await loadSession(phone);
  return s?.state || null;
}

async function clearSession(phone) {
  await deleteSession(phone);
}

// =======================
// CONTATO SUPORTE (link clicável)
// =======================
const SUPPORT_WA = "5519933005596";

// =======================
// PORTAL DO PACIENTE (ENV) — GLOBAL
// =======================
const PORTAL_URL = String(process.env.PORTAL_URL || "").trim();

// =======================
// TEXTOS
// =======================
const MSG = {
 
ASK_CPF_PORTAL: `Para prosseguir com o agendamento, preciso confirmar seu cadastro.\n\nEnvie seu CPF (somente números).`,
CPF_INVALIDO: `⚠️ CPF inválido. Envie 11 dígitos (somente números).`,

PLAN_DIVERGENCIA: `Notei uma divergência no convênio do seu cadastro.

Por gentileza, qual convênio você quer usar nesta consulta?`,

BTN_PLAN_PART: "Particular",
BTN_PLAN_MED: "MedSênior SP",
  
PORTAL_NEED_DATA: (faltas) => `Para prosseguir, preciso completar seu cadastro do Portal do Paciente.\n\nFaltam:\n${faltas}\n\nVamos continuar.`,
PORTAL_NEED_DATA_EXISTING: (faltas) =>
  `Encontrei seu cadastro ✅, mas precisamos completar algumas informações do Portal do Paciente.\n\nFaltam:\n${faltas}\n\nVamos continuar.`,

// ✅ NOVO: Bloqueio formal para paciente EXISTENTE com cadastro incompleto
PORTAL_EXISTENTE_INCOMPLETO_BLOQUEIO: (faltas) =>
  `Encontrei seu cadastro ✅, porém ele está incompleto no Portal do Paciente.\n\nPor segurança, o agendamento por aqui fica bloqueado neste caso.\n\nFaltam:\n${faltas}\n\n✅  Precisaria entrar em contato com um atendente para regularizar seu cadastro.`,

// ✅ NOVO: texto do botão único
BTN_FALAR_ATENDENTE: `Falar com atendente`,

ASK_NOME: `Informe seu nome completo:`,
ASK_DTNASC: `Informe sua data de nascimento (DD/MM/AAAA):`,
ASK_SEXO: `Selecione seu sexo:`,
ASK_CONVENIO: `Selecione o convênio para este agendamento:`,
ASK_EMAIL: `Informe seu e-mail:`,
ASK_CEP: `Informe seu CEP (somente números):`,
ASK_ENDERECO: `Informe seu endereço (logradouro):`,
ASK_NUMERO: `Número:`,
ASK_COMPLEMENTO: `Complemento (se não tiver, envie apenas 0):`,
ASK_BAIRRO: `Bairro:`,
ASK_CIDADE: `Cidade:`,
ASK_UF: `Estado (UF), ex.: SP:`,
PORTAL_OK_RESET: `✅ Cadastro do Portal atualizado.\n📩 Se você ainda não tem senha, enviamos um e-mail para redefinição.\n(Se não chegar, verifique o spam.)`,
  
  ENCERRAMENTO: `✅ Atendimento encerrado por inatividade.

🤝 Caso precise de algo mais, ficamos à disposição!
🙏 Agradecemos sua atenção!

📲 Siga-nos também no Instagram:
https://www.instagram.com/dr.david_vera/`,

  MENU: `👋 Olá! Sou a Cláudia, assistente virtual do Dr. David E. Vera.

Escolha uma opção:
1) Agendamento particular
2) Agendamento convênio
3) Acompanhamento pós-operatório
4) Falar com um atendente`,

  PARTICULAR: `Agendamento particular

💰 Valor da consulta: R$ 350,00

Onde será a consulta
📍 Consultório Livance – Campinas
Avenida Orosimbo Maia, 360
6º andar – Vila Itapura
Campinas – SP | CEP 13010-211

Ao chegar, realize o check-in no totem localizado na recepção da unidade.

Formas de pagamento
• Pix
• Débito
• Cartão de crédito

Os pagamentos são realizados no totem de atendimento no momento da chegada, antes da consulta.

Agendamento
Escolha uma opção:
1) Agendar minha consulta
0) Voltar ao menu inicial`,

  CONVENIOS: `Selecione o seu convênio:
1) GoCare
2) Samaritano
3) Salusmed
4) Proasa
5) MedSênior
0) Voltar ao menu inicial`,

  CONVENIO_GOCARE: `GoCare

O agendamento é feito pelo paciente diretamente na Clínica Santé.

📞 (19) 3995-0382

Se preferir, você também pode realizar a consulta de forma particular,
com agendamento rápido e direto por aqui.

Escolha uma opção:
9) Agendamento particular
0) Voltar ao menu inicial`,

  CONVENIO_SAMARITANO: `Samaritano

O agendamento é feito pelo paciente diretamente nas unidades disponíveis:

Hospital Samaritano de Campinas – Unidade 2

📞 (19) 3738-8100

Clínica Pró-Consulta de Sumaré

📞 (19) 3883-1314

Se preferir, você também pode realizar a consulta de forma particular,
com agendamento rápido e direto por aqui.

Escolha uma opção:
9) Agendamento particular
0) Voltar ao menu inicial`,

  CONVENIO_SALUSMED: `Salusmed

O agendamento é feito pelo paciente na Clínica Matuda

📞 (19) 3733-1111

Se preferir, você também pode realizar a consulta de forma particular,
com agendamento rápido e direto por aqui.

Escolha uma opção:
9) Agendamento particular
0) Voltar ao menu inicial`,

  CONVENIO_PROASA: `Proasa

O agendamento é feito pelo paciente no Centro Médico do CEVISA

📞 (19) 3858-5918

Se preferir, você também pode realizar a consulta de forma particular,
com agendamento rápido e direto por aqui.

Escolha uma opção:
9) Agendamento particular
0) Voltar ao menu inicial`,

  MEDSENIOR: `MedSênior

Para pacientes MedSênior, o agendamento é realizado diretamente por aqui.

📍 Consultório Livance – Campinas
Avenida Orosimbo Maia, 360
6º andar – Vila Itapura

Escolha uma opção:
1) Agendar minha consulta
0) Voltar ao menu inicial`,

  POS_MENU: `Acompanhamento pós-operatório

Este canal é destinado a pacientes operados pelo Dr. David E. Vera.

Escolha uma opção:
1) Pós-operatório recente (até 30 dias)
2) Pós-operatório tardio (mais de 30 dias)
0) Voltar ao menu inicial`,

  POS_RECENTE: `Pós-operatório recente
👉 Acesse o canal dedicado:
https://wa.me/5519933005596

Observação:
Solicitações administrativas (atestados, laudos, relatórios)
devem ser realizadas em consulta.

0) Voltar ao menu inicial`,

  POS_TARDIO: `Pós-operatório tardio

Para pós-operatório tardio, orientamos que as demandas não urgentes
sejam avaliadas em consulta.

Solicitações administrativas (atestados, laudos, relatórios) devem ser realizadas em consulta.

Escolha uma opção:
1) Agendamento particular
2) Agendamento convênio
0) Voltar ao menu inicial`,

  ATENDENTE: `Falar com um atendente

Este canal está disponível para apoio, dúvidas gerais
e auxílio no uso dos serviços da clínica.

Para solicitações médicas, como atestados, laudos,
orçamentos, relatórios ou orientações clínicas,
é necessária avaliação em consulta.

Descreva abaixo como podemos te ajudar.

0) Voltar ao menu inicial`,

  AJUDA_PERGUNTA: `Certo — me diga qual foi a dificuldade no agendamento (o que aconteceu).`,
};

// =======================
// PROBE: descobrir endpoint de UPDATE que funcione (sem PUT)
// =======================
const UPDATE_PROBE_CANDIDATES = [
  // Login/*
  "/api/Login/AlterarUsuario",
  "/api/Login/AtualizarUsuario",
  "/api/Login/SalvarUsuario",
  "/api/Login/EditarUsuario",
  "/api/Login/AtualizarDadosUsuario",
  "/api/Login/AtualizarCadastro",
  "/api/Login/AtualizarPortal",
  // Usuario/*
  "/api/Usuario/AlterarUsuario",
  "/api/Usuario/AtualizarUsuario",
  "/api/Usuario/SalvarUsuario",
];

function isProbablyIisBlock405(out) {
  if (out?.status !== 405) return false;
  if (typeof out?.data !== "string") return false;
  // IIS costuma devolver HTML com esse title
  return out.data.includes("HTTP verb used to access this page is not allowed");
}

function pickSafeProbePayload(payload) {
  // manda o mínimo, mas suficiente pra API “entender” que é update
  // IMPORTANTe: mantém no body, não em querystring
  return {
    CodUsuario: payload.CodUsuario,
    CPF: payload.CPF,
    Nome: payload.Nome,
  };
}

let versaUpdateResolved = null; // cache em memória: { path, method }

async function resolveVersaUpdateRoute(samplePayload) {
  if (versaUpdateResolved) return versaUpdateResolved;

  const forcedPath = String(process.env.VERSA_UPDATE_PATH || "").trim();
  const forcedMethod = String(process.env.VERSA_UPDATE_METHOD || "").trim().toUpperCase();

if (forcedPath && forcedMethod) {
  versaUpdateResolved = { path: forcedPath, method: forcedMethod };
  opLog("VERSA_UPDATE_ROUTE_FORCED_BY_ENV", {
    path: forcedPath,
    method: forcedMethod,
  });
  return versaUpdateResolved;
}

  const probeBody = pickSafeProbePayload(samplePayload);

  // 🔎 Nova estratégia:
  // 1) POST + override (simula PUT sem usar verbo PUT)
  // 2) POST puro
  // 3) PUT direto (por último)

  const variants = [
    {
      method: "POST",
      extraHeaders: {
        "X-HTTP-Method-Override": "PUT",
        "X-Method-Override": "PUT",
        "X-HTTP-Method": "PUT",
      },
      label: "POST+OVERRIDE",
    },
    {
      method: "POST",
      extraHeaders: null,
      label: "POST",
    },
    {
      method: "PUT",
      extraHeaders: null,
      label: "PUT",
    },
  ];

  for (const path of UPDATE_PROBE_CANDIDATES) {
    for (const v of variants) {
      const out = await versatilisFetch(path, {
        method: v.method,
        jsonBody: probeBody,
        ...(v.extraHeaders ? { extraHeaders: v.extraHeaders } : {}),
      });

    debugLog("VERSA_UPDATE_PROBE_ATTEMPT", {
      path,
      variant: v.label,
      method: v.method,
      httpStatus: out.status,
      technicalAccepted: out.ok,
      allow: out.allow || null,
      iis405: isProbablyIisBlock405(out),
    });

      const isHtml = typeof out?.data === "string" && out.data.trim().startsWith("<!DOCTYPE");
      const iis405 = isProbablyIisBlock405(out);

      const statusLooksApi =
        out.ok ||
        [400, 401, 403, 409, 422].includes(out.status);

      if (statusLooksApi && out.status !== 405 && !isHtml && !iis405) {
        versaUpdateResolved = {
          path,
          method: v.method,
          ...(v.extraHeaders ? { extraHeaders: v.extraHeaders } : {}),
        };

        opLog("VERSA_UPDATE_PROBE_RESOLVED", versaUpdateResolved);
        return versaUpdateResolved;
      }
    }
  }

  versaUpdateResolved = null;
  audit("VERSA_UPDATE_PROBE_NOT_RESOLVED", {
    functionalResult: "UPDATE_ROUTE_UNRESOLVED",
    escalationRequired: true,
  });
  return null;
}

async function versaAttachPlanIfMissing({ codUsuario, profile, planKeyToEnsure }) {
  const plans = normalizePlanListFromProfile(profile);
  const wantCod = codPlanoFromPlanKey(planKeyToEnsure);

  // já tem -> nada a fazer
  if (plans.some((p) => Number(p) === Number(wantCod))) {
    return { ok: true, changed: false, plansAfter: plans };
  }

  // tenta anexar
  const route = await resolveVersaUpdateRoute({
    CodUsuario: codUsuario,
    CPF: cleanStr(profile?.CPF),
    Nome: cleanStr(profile?.Nome),
  });

  if (!route) {
    return { ok: false, stage: "no_update_route" };
  }

  const mergedPlans = Array.from(new Set([...(plans || []), wantCod]));

  // Payload mínimo (evita depender de endereço etc.)
  // IMPORTANT: mantém CPF/Nome para ajudar a API a aceitar update.
  const payload = {
    CodUsuario: Number(codUsuario),
    CPF: cleanStr(profile?.CPF),
    Nome: cleanStr(profile?.Nome),
    CodPlano: String(wantCod),
    CodPlanos: mergedPlans,
  };

  const out = await versatilisFetch(route.path, {
    method: route.method,
    jsonBody: payload,
    ...(route.extraHeaders ? { extraHeaders: route.extraHeaders } : {}),
  });

  if (!out.ok) {
    return { ok: false, stage: "update_failed", out };
  }

  return { ok: true, changed: true, plansAfter: mergedPlans };
}

// =======================
// HELPERS
// =======================
function bookingConfirmKey(phone, codHorario) {
  const p = String(phone || "").replace(/\D+/g, "");
  return `booking:confirm:${p}:${codHorario}`;
}

const inboundLocks = new Map();

async function withPhoneLock(phone, fn) {
  const key = String(phone || "").replace(/\D+/g, "");
  const prev = inboundLocks.get(key) || Promise.resolve();

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const chain = prev.then(() => gate);
  inboundLocks.set(key, chain);

  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (inboundLocks.get(key) === chain) {
      inboundLocks.delete(key);
    }
  }
}
  
// Sessão do paciente fica no Redis.
// Maps em memória são usados apenas para utilidades locais do processo
// (ex.: supressão de logs e lock por telefone), sem persistência clínica.
async function setBookingPlan(phone, planoKey) {
  return await updateSession(phone, (s) => {
    s.booking = { ...(s.booking || {}), planoKey };
  });
}

async function getSession(phone) {
  return await ensureSession(phone);
}

async function setSession(phone, s) {
  await saveSession(phone, s);
  return s;
}

function resolveCodPlanoFromSession(s) {
  return resolveCodPlano(s?.booking?.planoKey);
}

function onlyCpfDigits(s) {
  const d = String(s || "").replace(/\D+/g, "");
  return d.length === 11 ? d : null;
}

function formatCellFromWA(phone) {
  // WhatsApp envia número como 5519XXXXXXXXX
  // Vamos manter somente dígitos
  return String(phone || "").replace(/\D+/g, "");
}

function maskPhone(p) {
  const s = String(p || "").replace(/\D+/g, "");
  if (!s) return "***";
  return s.length > 6 ? s.slice(0, 4) + "****" + s.slice(-2) : "***";
}

function maskKey(k) {
  const s = String(k || "");
  if (!s) return "***";
  return s.length > 12 ? s.slice(0, 8) + "***" : "***";
}

function formatMissing(list) {
  return list.map(x => `• ${x}`).join("\n");
}

function onlyDigits(s) {
  const t = (s || "").trim();
  return /^[0-9]+$/.test(t) ? t : null;
}

function normalizeSpaces(s) {
  return (s || "").trim().replace(/\s+/g, " ");
}

function makeWaLink(prefillText) {
  const encoded = encodeURIComponent(prefillText);
  return `https://wa.me/${SUPPORT_WA}?text=${encoded}`;
}

function parseDateBR(ddmmyyyy) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((ddmmyyyy || "").trim());
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

function toHHMM(hora) {
  const s = String(hora || "").trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return null;
  const hh = String(Number(m[1])).padStart(2, "0");
  return `${hh}:${m[2]}`;
}

// =======================
// dtNasc automático (SEM COLETA)
// - Busca em: portal.form -> portal.profile -> Versatilis por CodUsuario
// - Se não achar: não pede ao paciente; encaminha suporte
// =======================
async function getDtNascISOAuto(phone) {
  const s = await ensureSession(phone);

  // 1) Já na sessão (wizard)
  const dt1 = cleanStr(s?.portal?.form?.dtNascISO);
  if (dt1) return dt1;

  // 2) Do profile em cache na sessão
  const dtRaw = cleanStr(s?.portal?.profile?.DtNasc);
  const dt2 = parseBRDateToISO(dtRaw) || (function () {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dtRaw);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  })();
  if (dt2) return dt2;

  // 3) Busca por codUsuario (preferência: booking.codUsuario)
  const cod =
    Number(s?.booking?.codUsuario) ||
    Number(s?.portal?.codUsuario) ||
    null;

  if (!cod || !Number.isFinite(cod) || cod <= 0) return null;

  const prof = await versaGetDadosUsuarioPorCodigo(cod);
  if (!prof.ok || !prof.data) return null;

  const dtApiRaw = cleanStr(prof.data?.DtNasc);
  const dt3 =
    parseBRDateToISO(dtApiRaw) ||
    (function () {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dtApiRaw);
      return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
    })();

  // salva em sessão para próximas chamadas
    if (dt3) {
    await updateSession(phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.profile = sess.portal.profile || {};
      sess.portal.profile.DtNasc = prof.data?.DtNasc || sess.portal.profile.DtNasc;
      sess.portal.form = sess.portal.form || {};
      sess.portal.form.dtNascISO = dt3;
    });
  }

  return dt3 || null;
}

function pickLoginForSolicitarSenha(session) {
  const email = cleanStr(session?.portal?.form?.email || session?.portal?.profile?.Email);
  const cpf = cleanStr(session?.portal?.form?.cpf || session?.portal?.profile?.CPF).replace(/\D+/g, "");

  if (isValidEmail(email)) return { login: email, kind: "email" };
  if (cpf.length === 11) return { login: cpf, kind: "cpf" };

  return { login: "", kind: "none" };
}
  
// =======================
// REGRAS DE TEMPO (segurança)
// =======================
const MIN_LEAD_HOURS = 12;             // mínimo de 12h
const TZ_OFFSET = "-03:00";            // São Paulo (sem DST hoje)

// Constrói epoch ms do horário (data ISO + HH:MM) em fuso -03:00
function slotEpochMs(isoDate, hhmm) {
  // ex: 2026-02-24T07:30:00-03:00
  const d = new Date(`${isoDate}T${hhmm}:00${TZ_OFFSET}`);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

function isSlotAllowed(isoDate, hhmm) {
  const ms = slotEpochMs(isoDate, hhmm);
  if (!Number.isFinite(ms)) return false;
  const minMs = Date.now() + MIN_LEAD_HOURS * 60 * 60 * 1000;
  return ms >= minMs;
}

// =======================
// BUSCAR HORÁRIOS DO DIA (Versatilis) + filtro 12h
// =======================
async function fetchSlotsDoDia({ codColaborador, codUsuario, isoDate }) {
  const path =
    `/api/Agenda/Datas?CodColaborador=${encodeURIComponent(codColaborador)}` +
    `&CodUsuario=${encodeURIComponent(codUsuario)}` +
    `&DataInicial=${encodeURIComponent(isoDate)}` +
    `&DataFinal=${encodeURIComponent(isoDate)}`;

  const out = await versatilisFetch(path);

// 404 do Versatilis pode significar "sem datas disponíveis"
if (out.status === 404) {
  return { ok: true, slots: [] };
}

if (!out.ok || !Array.isArray(out.data)) {
  return { ok: false, slots: [] };
}

  const slots = out.data
    .filter((h) => h && h.PermiteConsulta === true && h.CodHorario != null)
    .map((h) => ({
      codHorario: Number(h.CodHorario),
      hhmm: toHHMM(h.Hora),
    }))
    .filter((x) => x.codHorario && x.hhmm)
    .sort((a, b) => a.hhmm.localeCompare(b.hhmm))
    // ✅ filtro 12h aqui
    .filter((x) => isSlotAllowed(isoDate, x.hhmm));

  return { ok: true, slots };
}

// =======================
// BUSCAR PRÓXIMAS 3 DATAS DISPONÍVEIS (com slots após filtro 12h)
// =======================
async function fetchNextAvailableDates({ codColaborador, codUsuario, daysLookahead = 60, limit = 3 }) {
  const dates = [];
  const start = new Date(); // hoje

  for (let i = 0; i < daysLookahead && dates.length < limit; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const isoDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    const out = await fetchSlotsDoDia({ codColaborador, codUsuario, isoDate });
    if (out.ok && out.slots.length > 0) {
      dates.push(isoDate);
    }
  }

  return dates; // ex: ["2026-02-24","2026-02-26","2026-02-27"]
}

function formatBRFromISO(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ""));
  if (!m) return isoDate;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

// =======================
// MOSTRAR 3 DATAS DISPONÍVEIS
// =======================
async function showNextDates({ phone, phoneNumberIdFallback, codColaborador, codUsuario }) {
  const dates = await fetchNextAvailableDates({ codColaborador, codUsuario, daysLookahead: 60, limit: 3 });

  if (!dates.length) {
    await sendText({
      to: phone,
      body: "⚠️ Não encontrei datas disponíveis nos próximos dias.",
      phoneNumberIdFallback,
    });
    return false;
  }

  const buttons = dates.map((iso) => ({
    id: `D_${iso}`,
    title: formatBRFromISO(iso),
  }));

  await sendButtons({
    to: phone,
    body: "Escolha uma data:",
    buttons,
    phoneNumberIdFallback,
  });

  return true;
}

// =======================
// MOSTRAR 3 HORÁRIOS POR VEZ + navegação + trocar data
// =======================
async function showSlotsPage({ phone, phoneNumberIdFallback, slots, page = 0 }) {
  const pageSize = 3;
  const start = page * pageSize;
  const end = start + pageSize;

  const pageItems = slots.slice(start, end);

  if (!pageItems.length) {
    await sendText({
      to: phone,
      body: "⚠️ Não há horários disponíveis (considerando o mínimo de 12h).",
      phoneNumberIdFallback,
    });

    await sendButtons({
      to: phone,
      body: "Deseja escolher outra data?",
      buttons: [{ id: "TROCAR_DATA", title: "Trocar data" }],
      phoneNumberIdFallback,
    });
    return;
  }

  const buttons = pageItems.map((x) => ({
    id: `H_${x.codHorario}`,
    title: x.hhmm,
  }));

  await sendButtons({
    to: phone,
    body: "Horários disponíveis:",
    buttons,
    phoneNumberIdFallback,
  });

  const extraButtons = [];

  if (end < slots.length) {
    extraButtons.push({ id: `PAGE_${page + 1}`, title: "Ver mais" });
  }
  extraButtons.push({ id: "TROCAR_DATA", title: "Trocar data" });

  await sendButtons({
    to: phone,
    body: "Opções:",
    buttons: extraButtons,
    phoneNumberIdFallback,
  });
}

// =======================
// ENV SEND BASE
// =======================
function getSendConfig(phoneNumberIdFallback) {
  const token = pickToken();
  const phoneNumberId = pickPhoneNumberId(phoneNumberIdFallback);

  if (!token) {
    errLog("WHATSAPP_SEND_CONFIG_MISSING_TOKEN", {
      hasPhoneNumberIdFallback: !!phoneNumberIdFallback,
    });
    return null;
  }

  if (!phoneNumberId) {
    errLog("WHATSAPP_SEND_CONFIG_MISSING_PHONE_NUMBER_ID", {
      hasFallback: !!phoneNumberIdFallback,
    });
    return null;
  }

  return {
    token,
    url: `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
  };
}

// =======================
// TEXTO SIMPLES
// =======================
async function sendText({ to, body, phoneNumberIdFallback }) {
  const config = getSendConfig(phoneNumberIdFallback);
  if (!config) return false;

  const resp = await fetch(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      text: { body },
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    errLog("WHATSAPP_SEND_TEXT_FAIL", {
      phoneMasked: maskPhone(to),
      httpStatus: resp.status,
      responsePreview: txt ? String(txt).slice(0, 500) : "",
      bodyLength: String(body || "").length,
    });
    return false;
  }

  return true;
}

// =======================
// BOTÕES (INTERACTIVE)
// =======================
async function sendButtons({ to, body, buttons, phoneNumberIdFallback }) {
  const config = getSendConfig(phoneNumberIdFallback);
  if (!config) return false;

  const resp = await fetch(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: {
          buttons: buttons.map((b) => ({
            type: "reply",
            reply: {
              id: b.id,
              title: b.title,
            },
          })),
        },
      },
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    errLog("WHATSAPP_SEND_BUTTONS_FAIL", {
      phoneMasked: maskPhone(to),
      httpStatus: resp.status,
      responsePreview: txt ? String(txt).slice(0, 500) : "",
      buttonCount: Array.isArray(buttons) ? buttons.length : 0,
      bodyLength: String(body || "").length,
    });
    return false;
  }

  return true;
}

// =======================
// ENVIO + ESTADO
// =======================
async function sendAndSetState(phone, body, state, phoneNumberIdFallback) {
  const sent = await sendText({
    to: phone,
    body,
    phoneNumberIdFallback,
  });

  if (state) {
    await setState(phone, state);

    const back = await getState(phone);
    debugLog("FLOW_STATE_TRANSITION", {
      phoneMasked: maskPhone(phone),
      targetState: state,
      readbackState: back || "(none)",
      outboundMessageSent: !!sent,
      outboundMessageLength: String(body || "").length,
    });
  }
}

// =======================
// RESET LIMPO PARA MAIN (limpa pendências antigas)
// =======================
async function resetToMain(phone, phoneNumberIdFallback) {
  await updateSession(phone, (s) => {
    if (s?.portal?.issue) delete s.portal.issue;
    if (s?.portal?.missing) delete s.portal.missing;
    if (s?.pending) delete s.pending;
  });

  await sendAndSetState(phone, MSG.MENU, "MAIN", phoneNumberIdFallback);
}

// =======================
// AUTO-ENCERRAMENTO (10 min silêncio)
// - envia mensagem
// - limpa estado
// =======================
// setInterval de auto-encerramento desativado temporariamente
// (com Redis não listamos sessões por segurança; vamos tratar isso no próximo passo)

// =======================
// ROTEADOR COM ESTADO MÍNIMO
// =======================
async function handleInbound(phone, inboundText, phoneNumberIdFallback, traceMeta = {}) {
  await touchUser(phone, phoneNumberIdFallback);

  const traceId = traceMeta?.traceId || crypto.randomUUID();

  const raw = normalizeSpaces(inboundText);
  let upper = raw.toUpperCase();
  const digits = onlyDigits(raw);
  const currentState = (await getState(phone)) || "MAIN";

debugLog("FLOW_INBOUND_RECEIVED", {
  traceId,
  phoneMasked: maskPhone(phone),
  state: currentState,
  inboundKind: digits ? "digits-or-button" : "text",
});

 // =======================
// RESET GLOBAL (funciona em qualquer etapa) — robusto
// Aceita:
// - "#menu123" exatamente
// - variação de maiúsc/minúsc
// - se ENV estiver sem "#", aceita com ou sem "#"
// =======================
{
  const code = String(FLOW_RESET_CODE || "").trim();
  if (code) {
    const msg = String(raw || "").trim();
    const msgU = msg.toUpperCase();

    const codeU = code.toUpperCase();
    const withHashU = ("#" + code).toUpperCase();

    const hit =
      msgU === codeU ||
      msgU === withHashU ||
      (code.startsWith("#") && msgU === codeU) ||
      (!code.startsWith("#") && msgU === ("#" + codeU));

    if (hit) {
      audit("FLOW_RESET_TRIGGERED", {
        traceId,
        tracePhone: maskPhone(phone),
        stateBeforeReset: currentState,
      });

      await clearSession(phone);
      await sendAndSetState(phone, MSG.MENU, "MAIN", phoneNumberIdFallback);
      return;
    }
  }
}

// =======================
// BOTÃO GLOBAL: FALAR COM ATENDENTE (qualquer momento)
// =======================
if (upper === "FALAR_ATENDENTE") {
  const s = await ensureSession(phone);

 const cpf = String(s?.portal?.form?.cpf || "").replace(/\D+/g, "");
const faltas = Array.isArray(s?.portal?.missing) ? s.portal.missing : [];
const issue = s?.portal?.issue || null;

const motivo =
  issue?.type === "CONVENIO_NAO_HABILITADO"
    ? `Convênio não habilitado no cadastro (precisa atualizar plano no Versatilis). Desejado: ${issue.wantedPlan}.`
    : "";

const detalhesPlano =
  issue?.type === "CONVENIO_NAO_HABILITADO"
    ? `CodUsuario: ${issue.codUsuario || "(não identificado)"} | Planos detectados: ${
        Array.isArray(issue.plansDetected) && issue.plansDetected.length ? issue.plansDetected.join(", ") : "(nenhum)"
      }`
    : "";

const prefill = `Olá! Preciso de ajuda no agendamento.

Paciente: ${phone}
CPF: ${cpf || "(não informado)"}
${motivo ? `Motivo: ${motivo}` : ""}
${detalhesPlano ? `Detalhes: ${detalhesPlano}` : ""}
${faltas.length ? `Pendências de cadastro: ${faltas.join(", ")}` : ""}`.trim();
  ;

  const link = makeWaLink(prefill);

  await sendAndSetState(
    phone,
    `✅ Para falar com nossa equipe, clique no link abaixo e envie a mensagem:\n\n${link}`,
    "MAIN",
    phoneNumberIdFallback
  );
  return;
}
  
  const ctx = (await getState(phone)) || "MAIN";

// Compatibilidade: se vier botão antigo, redireciona
if (upper === "REENVIAR_SENHA" || upper === "SENHA" || upper === "ESQUECI_SENHA") {
  upper = "PWD_MUDAR";
}

// =======================
// BOTÕES GLOBAIS: CRIAR SENHA / MUDAR SENHA (qualquer momento)
// - NÃO pede data de nascimento
// - dtNasc vem automaticamente via Versatilis (CodUsuario -> DadosUsuarioPorCodigo)
// - se falhar, encaminha suporte
// =======================
if (upper === "PWD_CRIAR" || upper === "PWD_MUDAR") {
  const s = await ensureSession(phone);

  const cpf = String(s?.portal?.form?.cpf || "").replace(/\D+/g, "");

  // Se por algum motivo não houver CPF na sessão, volta pro CPF do wizard
  if (cpf.length !== 11) {
    await sendAndSetState(
      phone,
      "Para enviar o e-mail de senha do Portal, envie seu CPF (somente números).",
      "WZ_CPF",
      phoneNumberIdFallback
    );
    return;
  }

  // ✅ dtNasc automático (sem coletar)
  const dtNascISO = await getDtNascISOAuto(phone);

  if (!dtNascISO) {
    const prefill = `Olá! Preciso de ajuda para receber a senha do Portal do Paciente.

Paciente: ${phone}
CPF: ${cpf}
Motivo: não consegui obter a data de nascimento automaticamente para disparar o reset.`;
    const link = makeWaLink(prefill);

    await sendText({
      to: phone,
      body: `⚠️ Não consegui disparar o e-mail automaticamente.\n\n✅ Para suporte, clique:\n${link}`,
      phoneNumberIdFallback,
    });

    await setState(phone, "MAIN");
    return;
  }

  // ✅ chama versão robusta (corrige o 400)
 const out = await versaSolicitarSenhaPorCPF(cpf, dtNascISO, {
  traceId,
  tracePhone: maskPhone(phone),
  entryPoint: upper,
  currentState: ctx,
});

audit("RESET_PASSWORD_FLOW", auditOutcome({
  traceId,
  tracePhone: maskPhone(phone),
  entryPoint: upper,
  currentState: ctx,
  cpfMasked: "***",
  dtNascMasked: "***",
  technicalAccepted: !!out?.ok,
  technicalStage: out?.stage || null,
  httpStatus: out?.out?.status || null,
  rid: out?.out?.rid || null,
  usedParam: out?.usedParam || null,
  loginKindWinner:
    out?.traceMeta?.loginKind ||
    out?.loginKind ||
    null,
  loginValueMasked:
    out?.traceMeta?.loginMasked ||
    null,
  functionalResult: out?.ok ? "UNCONFIRMED_EMAIL_DELIVERY" : "NOT_COMPLETED",
  patientFacingMessage:
    out?.ok
      ? "RESET_EMAIL_REPORTED_AS_SENT"
      : "RESET_FAILED_SUPPORT_REQUIRED",
  escalationRequired: !out?.ok,
  note:
    out?.ok
      ? "HTTP 200/OK da API nao comprova envio real do email nem reset funcional."
      : "Fluxo de reset nao concluiu com sucesso tecnico.",
}));
  
  if (!out.ok) {
    const prefill = `Olá! Não estou recebendo o e-mail de redefinição de senha do Portal do Paciente.

Paciente: ${phone}
CPF: ${cpf}
Motivo: SolicitarSenha falhou (integração retornou erro).`;
    const link = makeWaLink(prefill);

    await sendText({
      to: phone,
      body: `⚠️ Não consegui enviar o e-mail agora.\n\n✅ Para suporte, clique:\n${link}`,
      phoneNumberIdFallback,
    });

    await setState(phone, "MAIN");
    return;
  }

  await sendText({
    to: phone,
    body:
      "✅ Pronto! Enviamos o e-mail para redefinição de senha do Portal.\n" +
      "Se não chegar, verifique também o Spam/Lixo Eletrônico.",
    phoneNumberIdFallback,
  });

  if (PORTAL_URL) {
    await sendText({
      to: phone,
      body: `🔗 Portal do Paciente:\n${PORTAL_URL}`,
      phoneNumberIdFallback,
    });
  }

  await setState(phone, "MAIN");
  return;
}
  
// =======================
// BLOQUEIO FORMAL: PACIENTE EXISTENTE COM CADASTRO INCOMPLETO
// ÚNICA OPÇÃO = HUMANO
// =======================
if (ctx === "BLOCK_EXISTING_INCOMPLETE") {
  // Sempre gera link para humano com prefill (sem depender do que o usuário digitar)
  const s = await ensureSession(phone);

  const cpf = String(s?.portal?.form?.cpf || "").replace(/\D+/g, "");
  const faltas = Array.isArray(s?.portal?.missing) ? s.portal.missing : [];

  const prefill = `Olá! Preciso de ajuda para completar meu cadastro no Portal do Paciente.

Paciente: ${phone}
CPF: ${cpf || "(não informado)"}
Pendências: ${faltas.length ? faltas.join(", ") : "(não identificado)"}`;

  const link = makeWaLink(prefill);

  await sendText({
    to: phone,
    body: `✅ Para regularizar seu cadastro, clique no link abaixo e envie a mensagem:\n\n${link}`,
    phoneNumberIdFallback,
  });

  // Mantém estado em MAIN depois de encaminhar
  await setState(phone, "MAIN");
  return;
}

// =======================
// PLANO DIVERGENTE: escolher qual usar neste agendamento
// =======================
if (ctx === "PLAN_PICK") {
  // ✅ permite encaminhar ao atendente aqui também
  if (upper === "FALAR_ATENDENTE") {
    // reutiliza seu handler global (ele já existe acima),
    // mas como aqui estamos dentro do PLAN_PICK, chamamos o mesmo comportamento:
    const s = await ensureSession(phone);

    const cpf = String(s?.portal?.form?.cpf || "").replace(/\D+/g, "");
const faltas = Array.isArray(s?.portal?.missing) ? s.portal.missing : [];
const issue = s?.portal?.issue || null;

const motivo =
  issue?.type === "CONVENIO_NAO_HABILITADO"
    ? `Convênio não habilitado no cadastro (precisa atualizar plano no Versatilis). Desejado: ${issue.wantedPlan}.`
    : "";

const detalhesPlano =
  issue?.type === "CONVENIO_NAO_HABILITADO"
    ? `CodUsuario: ${issue.codUsuario || "(não identificado)"} | Planos detectados: ${
        Array.isArray(issue.plansDetected) && issue.plansDetected.length ? issue.plansDetected.join(", ") : "(nenhum)"
      }`
    : "";

const prefill = `Olá! Preciso de ajuda no agendamento.

Paciente: ${phone}
CPF: ${cpf || "(não informado)"}
${motivo ? `Motivo: ${motivo}` : ""}
${detalhesPlano ? `Detalhes: ${detalhesPlano}` : ""}
${faltas.length ? `Pendências de cadastro: ${faltas.join(", ")}` : ""}`.trim();

    const link = makeWaLink(prefill);

    await sendAndSetState(
      phone,
      `✅ Para falar com nossa equipe, clique no link abaixo e envie a mensagem:\n\n${link}`,
      "MAIN",
      phoneNumberIdFallback
    );
    return;
  }

  if (upper !== "PL_USE_PART" && upper !== "PL_USE_MED") {
    // não força mostrar PL_USE_MED se ele não estiver disponível no contexto atual
    await sendText({
      to: phone,
      body: "Use os botões apresentados para prosseguir.",
      phoneNumberIdFallback,
    });
    return;
  }

const chosenKey = (upper === "PL_USE_MED") ? PLAN_KEYS.MEDSENIOR_SP : PLAN_KEYS.PARTICULAR;

const s = await updateSession(phone, (sess) => {
  sess.booking = sess.booking || {};
  sess.booking.planoKey = chosenKey;

  if (sess.portal && sess.portal.issue) {
    delete sess.portal.issue;
  }
});

const codUsuario = Number(s?.booking?.codUsuario || s?.portal?.codUsuario);
if (!codUsuario) {
  await sendText({
    to: phone,
    body: "⚠️ Sessão inválida. Digite 1 para iniciar novamente.",
    phoneNumberIdFallback
  });
  await setState(phone, "MAIN");
  return;
}

await finishWizardAndGoToDates({
  phone,
  phoneNumberIdFallback,
  codUsuario,
  planoKeyFromWizard: chosenKey,
  traceId,
});

return;
}
  
// =======================
// AGENDAMENTO (datas + slots + confirmação)
// =======================

// 1) Usuário escolhe uma DATA (botão D_YYYY-MM-DD)
if (upper.startsWith("D_")) {
  const isoDate = raw.slice(2).trim(); // YYYY-MM-DD
  const s = await getSession(phone);

  const codColaborador = s?.booking?.codColaborador ?? COD_COLABORADOR;
  const codUsuario = s?.booking?.codUsuario;

  if (!codUsuario) {
    await sendText({
      to: phone,
      body: "⚠️ Sessão inválida. Digite 1 para iniciar novamente.",
      phoneNumberIdFallback,
    });
    await setState(phone, "MAIN");
    return;
  }

  const out = await fetchSlotsDoDia({ codColaborador, codUsuario, isoDate });
  const slots = out.ok ? out.slots : [];

  await updateSession(phone, (sess) => {
    sess.booking = {
      ...(sess.booking || {}),
      codColaborador,
      codUsuario,
      isoDate,
      pageIndex: 0,
      slots,
    };
    sess.state = "SLOTS";
  });

  await showSlotsPage({ phone, phoneNumberIdFallback, slots, page: 0 });
  return;
}

// 2) Estado ASK_DATE_PICK: aguardando escolher data (apenas botões)
if (ctx === "ASK_DATE_PICK") {
  // Se o usuário digitou algo aleatório, reapresenta datas
  const s = await ensureSession(phone);
  const codColaborador = s?.booking?.codColaborador ?? COD_COLABORADOR;
  const codUsuario = s?.booking?.codUsuario;
if (!codUsuario) {
  await sendText({
    to: phone,
    body: "⚠️ Sessão inválida. Digite 1 para iniciar novamente.",
    phoneNumberIdFallback,
  });
   await setState(phone, "MAIN");
  return;
}

  const shown = await showNextDates({ phone, phoneNumberIdFallback, codColaborador, codUsuario });
  if (shown) {
    await setState(phone, "ASK_DATE_PICK");
  }
  return;
  }

// 3) Estado SLOTS: paginação / trocar data / escolher horário
if (ctx === "SLOTS") {
  // Ver mais (PAGE_n)
  if (upper.startsWith("PAGE_")) {
    const n = Number(raw.split("_")[1]);
    const s = await updateSession(phone, (sess) => {
      sess.booking = sess.booking || {};
      sess.booking.pageIndex = Number.isFinite(n) && n >= 0 ? n : 0;
    });
    
    const slots = s?.booking?.slots || [];
    const page = Number(s?.booking?.pageIndex ?? 0) || 0;

    await showSlotsPage({
      phone,
      phoneNumberIdFallback,
      slots,
      page,
    });
    return;
  }

  // Trocar data
   if (upper === "TROCAR_DATA") {
    const s = await ensureSession(phone);
    const codColaborador = s?.booking?.codColaborador ?? COD_COLABORADOR;
    const codUsuario = s?.booking?.codUsuario;

    await updateSession(phone, (sess) => {
      if (sess?.booking) {
        sess.booking.isoDate = null;
        sess.booking.slots = [];
        sess.booking.pageIndex = 0;
      }
    });

    if (!codUsuario) {
      await sendText({
        to: phone,
        body: "⚠️ Sessão inválida. Digite 1 para iniciar novamente.",
        phoneNumberIdFallback,
      });
      await setState(phone, "MAIN");
      return;
    }

    const shown = await showNextDates({ phone, phoneNumberIdFallback, codColaborador, codUsuario });
    if (shown) {
      await setState(phone, "ASK_DATE_PICK");
    }
    return;
    }

  // Clique em horário (H_XXXX) -> vai para confirmação
    if (upper.startsWith("H_")) {
    const codHorario = Number(raw.split("_")[1]);
    if (!codHorario || Number.isNaN(codHorario)) {
      await sendText({ to: phone, body: "⚠️ Horário inválido.", phoneNumberIdFallback });
      return;
    }

    await updateSession(phone, (s) => {
      s.pending = { codHorario };
      s.state = "WAIT_CONFIRM";
    });

    await sendButtons({
      to: phone,
      body: `✅ Horário selecionado.\n\nDeseja confirmar este horário?`,
      buttons: [
        { id: "CONFIRMAR", title: "Confirmar" },
        { id: "ESCOLHER_OUTRO", title: "Escolher outro" },
      ],
      phoneNumberIdFallback,
    });
    return;
  }

  // fallback dentro de SLOTS: reapresenta a página atual
  {
    const s = await ensureSession(phone);
    const slots = s?.booking?.slots || [];
    const page = Number(s?.booking?.pageIndex ?? 0) || 0;

    await showSlotsPage({ phone, phoneNumberIdFallback, slots, page });
    return;
  }
}

// 4) Estado WAIT_CONFIRM: confirmar / escolher outro
if (ctx === "WAIT_CONFIRM") {
  if (upper === "ESCOLHER_OUTRO") {
  const s = await ensureSession(phone);
  const slots = s?.booking?.slots || [];

  await updateSession(phone, (sess) => {
    delete sess.pending;
    sess.state = "SLOTS";
  });

  await showSlotsPage({ phone, phoneNumberIdFallback, slots, page: 0 });
  return;
}

if (upper === "CONFIRMAR") {
  const s = await ensureSession(phone);
  const codHorario = Number(s?.pending?.codHorario);
  const planoSelecionado = resolveCodPlano(s?.booking?.planoKey || PLAN_KEYS.PARTICULAR);

  const payload = {
    CodUnidade: COD_UNIDADE,
    CodEspecialidade: COD_ESPECIALIDADE,
    CodPlano: planoSelecionado,
    CodHorario: codHorario,
    CodUsuario: s?.booking?.codUsuario,
    CodColaborador: COD_COLABORADOR,
    BitTelemedicina: false,
    Confirmada: true,
  };

  if (!payload.CodUsuario) {
    await sendText({
      to: phone,
      body: "⚠️ Não consegui identificar o paciente. Digite AJUDA.",
      phoneNumberIdFallback,
    });
    await setState(phone, "MAIN");
    return;
  }

 if (!codHorario || Number.isNaN(codHorario)) {
  const slots = s?.booking?.slots || [];

  await updateSession(phone, (sess) => {
    delete sess.pending;
    sess.state = "SLOTS";
  });

  await sendText({
    to: phone,
    body: "⚠️ Não encontrei o horário selecionado. Escolha novamente.",
    phoneNumberIdFallback,
  });

  await showSlotsPage({ phone, phoneNumberIdFallback, slots, page: 0 });
  return;
}

  const bookingKey = bookingConfirmKey(phone, codHorario);
  const lockOk = await redis.set(bookingKey, "1", { ex: 60, nx: true });

  if (!lockOk) {
    await sendText({
      to: phone,
      body: "⏳ Seu agendamento já está sendo processado. Aguarde alguns segundos.",
      phoneNumberIdFallback,
    });
    return;
  }

  try {
    const isoDate = s?.booking?.isoDate;
    const chosen = (s?.booking?.slots || []).find((x) => Number(x.codHorario) === codHorario);

    if (!isoDate || !chosen?.hhmm || !isSlotAllowed(isoDate, chosen.hhmm)) {
      await updateSession(phone, (sess) => {
        delete sess.pending;
        sess.state = "SLOTS";
      });

      await sendText({
        to: phone,
        body: "⚠️ Este horário não pode mais ser agendado (mínimo de 12h). Escolha outro.",
        phoneNumberIdFallback,
      });

      const codColaborador = s?.booking?.codColaborador ?? COD_COLABORADOR;
      const codUsuario = s?.booking?.codUsuario;

      if (!codUsuario) {
        await sendText({
          to: phone,
          body: "⚠️ Sessão inválida. Digite 1 para iniciar novamente.",
          phoneNumberIdFallback,
        });
        await setState(phone, "MAIN");
        return;
      }

      const outSlots = await fetchSlotsDoDia({ codColaborador, codUsuario, isoDate });

      await updateSession(phone, (sess) => {
        sess.booking = sess.booking || {};
        sess.booking.slots = outSlots.ok ? outSlots.slots : [];
      });

      const sUpdated = await ensureSession(phone);

      await showSlotsPage({
        phone,
        phoneNumberIdFallback,
        slots: sUpdated?.booking?.slots || [],
        page: 0,
      });
      return;
    }

    const out = await versatilisFetch("/api/Agenda/ConfirmarAgendamento", {
      method: "POST",
      jsonBody: payload,
      traceMeta: {
        traceId,
        flow: "CONFIRMAR_AGENDAMENTO",
        tracePhone: maskPhone(phone),
        codUsuario: payload.CodUsuario || null,
        codHorario: payload.CodHorario || null,
        codPlano: payload.CodPlano || null,
        codColaborador: payload.CodColaborador || null,
      },
    });

    audit("BOOKING_CONFIRM_FLOW", auditOutcome({
      traceId,
      tracePhone: maskPhone(phone),
      codUsuario: payload.CodUsuario || null,
      codHorario: payload.CodHorario || null,
      codPlano: payload.CodPlano || null,
      codColaborador: payload.CodColaborador || null,
      isoDate: s?.booking?.isoDate || null,
      hhmm: chosen?.hhmm || null,
      rid: out?.rid || null,
      httpStatus: out?.status || null,
      technicalAccepted: !!out?.ok,
      functionalResult: !!out?.ok ? "BOOKING_PRESUMED_CREATED" : "BOOKING_NOT_CONFIRMED",
      patientFacingMessage: !!out?.ok
        ? "BOOKING_SUCCESS_WITH_PORTAL_GUIDANCE"
        : "BOOKING_FAILURE_RETRY_OR_SUPPORT",
      escalationRequired: !out?.ok,
    }));

   if (!out.ok) {
  await updateSession(phone, (sess) => {
    delete sess.pending;
    sess.state = "SLOTS";
  });

  await sendText({
    to: phone,
    body: "⚠️ Não consegui confirmar agora. Tente outro horário ou digite AJUDA.",
    phoneNumberIdFallback,
  });

      audit("BOOKING_CONFIRM_PATIENT_RESPONSE", auditOutcome({
        traceId,
        tracePhone: maskPhone(phone),
        rid: out?.rid || null,
        httpStatus: out?.status || null,
        technicalAccepted: false,
        functionalResult: "BOOKING_NOT_CONFIRMED",
        patientFacingMessage: "BOOKING_FAILURE_RETRY_OR_SUPPORT",
        patientMessageSent: true,
        escalationRequired: true,
      }));

      const slots = s?.booking?.slots || [];
      await showSlotsPage({ phone, phoneNumberIdFallback, slots, page: 0 });
      return;
    }

    const msgOk = out?.data?.Message || out?.data?.message || "Agendamento confirmado com sucesso!";

    const ORIENTACOES = `Para que sua experiência seja ainda mais tranquila, recomendamos que chegue com 15 minutos de antecedência.

Nossa sala de espera foi pensada com carinho para seu conforto: ambiente acolhedor, água disponível, Wi-Fi gratuito e honest market com opções variadas.

Há estacionamento com valet no prédio.

Leve um documento oficial com foto para realizar seu cadastro na recepção do edifício e dirija-se ao 6º andar. Ao chegar, identifique-se no totem de atendimento.`;

    const PORTAL_INFO = `📲 Portal do Paciente

No Portal, você pode:
• Consultar e atualizar seus dados cadastrais  
• Acompanhar seus agendamentos  
• Acessar informações e serviços disponíveis  

🔑 Acesso ao Portal  
Caso ainda não tenha senha ou não se recorde dela,  
acesse o Portal e selecione a opção **“Esqueci minha senha”**.  

As instruções para redefinição serão enviadas automaticamente para o e-mail cadastrado.`;

    try {
      await setState(phone, "MAIN");

      const sentMainSuccess = await sendText({
        to: phone,
        body: `✅ ${msgOk}\n\n${ORIENTACOES}\n\n${PORTAL_INFO}`,
        phoneNumberIdFallback,
      });

      let sentPortalLink = false;
      if (PORTAL_URL) {
        sentPortalLink = await sendText({
          to: phone,
          body: `🔗 Portal do Paciente:\n${PORTAL_URL}`,
          phoneNumberIdFallback,
        });
      }

      const sentPasswordInfo = await sendText({
        to: phone,
        body:
          `🔐 Senha / Acesso\n` +
          `A senha é enviada por e-mail (conforme cadastro no Portal).\n` +
          `Se precisar, posso reenviar agora por aqui.`,
        phoneNumberIdFallback,
      });

      const sentPasswordButtons = await sendButtons({
        to: phone,
        body: "Senha do Portal do Paciente:",
        buttons: [
          { id: "PWD_CRIAR", title: "Criar senha" },
          { id: "PWD_MUDAR", title: "Mudar senha" },
          { id: "FALAR_ATENDENTE", title: "Falar com atendente" },
        ],
        phoneNumberIdFallback,
      });

      audit("BOOKING_CONFIRM_PATIENT_RESPONSE", auditOutcome({
        traceId,
        tracePhone: maskPhone(phone),
        rid: out?.rid || null,
        httpStatus: out?.status || null,
        technicalAccepted: true,
        functionalResult: "BOOKING_PRESUMED_CREATED",
        patientFacingMessage: "BOOKING_SUCCESS_WITH_PORTAL_GUIDANCE",
        patientMessageMainSent: !!sentMainSuccess,
        patientMessagePortalLinkSent: !!sentPortalLink,
        patientMessagePasswordInfoSent: !!sentPasswordInfo,
        patientMessagePasswordButtonsSent: !!sentPasswordButtons,
        escalationRequired: false,
      }));
    } catch (e) {
      audit("BOOKING_POST_CONFIRM_COMMUNICATION_FAILURE", auditOutcome({
        traceId,
        tracePhone: maskPhone(phone),
        rid: out?.rid || null,
        httpStatus: out?.status || null,
        technicalAccepted: true,
        functionalResult: "BOOKING_CREATED_BUT_COMMUNICATION_PARTIAL_FAILURE",
        patientFacingMessage: "BOOKING_SUCCESS_FALLBACK_MESSAGE",
        escalationRequired: false,
      }));

      const fallbackSent = await sendText({
        to: phone,
        body: "✅ Agendamento confirmado. Se precisar, digite MENU para voltar.",
        phoneNumberIdFallback,
      });

      audit("BOOKING_CONFIRM_PATIENT_RESPONSE", auditOutcome({
        traceId,
        tracePhone: maskPhone(phone),
        rid: out?.rid || null,
        httpStatus: out?.status || null,
        technicalAccepted: true,
        functionalResult: "BOOKING_PRESUMED_CREATED",
        patientFacingMessage: "BOOKING_SUCCESS_FALLBACK_MESSAGE",
        patientMessageFallbackSent: !!fallbackSent,
        escalationRequired: false,
      }));
    }

    return;
  } finally {
    await redis.del(bookingKey).catch(() => {});
  }
}
  
  await sendButtons({
    to: phone,
    body: "Use os botões abaixo:",
    buttons: [
      { id: "CONFIRMAR", title: "Confirmar" },
      { id: "ESCOLHER_OUTRO", title: "Escolher outro" },
    ],
    phoneNumberIdFallback,
  });
  return;
}

  // AJUDA -> pergunta motivo
  if (upper === "AJUDA") {
    await sendAndSetState(phone, MSG.AJUDA_PERGUNTA, "WAIT_AJUDA_MOTIVO", phoneNumberIdFallback);
    return;
  }

  // Captura motivo da AJUDA e devolve link clicável com texto preenchido
  if (ctx === "WAIT_AJUDA_MOTIVO") {
    const prefill = `Olá! Preciso de ajuda no agendamento.

Paciente: ${phone}
Motivo: ${raw}`;
    const link = makeWaLink(prefill);

    await sendAndSetState(
      phone,
      `Perfeito ✅ Para falar com nossa equipe, clique no link abaixo e envie a mensagem:

${link}`,
      "MAIN",
      phoneNumberIdFallback
    );
    return;
  }

 // Texto livre: se estiver em ATENDENTE, gera link com a mensagem
// ⚠️ NÃO aplicar fallback enquanto estiver em wizard WZ_*
if (!digits && !String(ctx || "").startsWith("WZ_")) {
  if (ctx === "ATENDENTE") {
    const prefill = `Olá! Preciso falar com um atendente.

Paciente: ${phone}
Mensagem: ${raw}`;
    const link = makeWaLink(prefill);

    await sendAndSetState(
      phone,
      `Certo ✅ Clique no link abaixo para falar com nossa equipe e envie a mensagem:

${link}`,
      "MAIN",
      phoneNumberIdFallback
    );
    return;
  }

// padrão: volta ao menu (limpando pendências antigas)
await resetToMain(phone, phoneNumberIdFallback);
return;
}

// =======================
// WIZARD PORTAL COMPLETO (CPF obrigatório)
// =======================
// ordem fixa de coleta quando precisa completar
function nextWizardStateFromMissing(missingList) {
  const m = new Set((missingList || []).map(x => String(x).toLowerCase()));

  // mesma linguagem do validatePortalCompleteness
  if (m.has("nome completo")) return "WZ_NOME";
  if (m.has("data de nascimento")) return "WZ_DTNASC";
  if (m.has("e-mail")) return "WZ_EMAIL";
  if (m.has("cep")) return "WZ_CEP";
  if (m.has("endereço")) return "WZ_ENDERECO";
  if (m.has("número")) return "WZ_NUMERO";
  if (m.has("bairro")) return "WZ_BAIRRO";
  if (m.has("cidade")) return "WZ_CIDADE";
  if (m.has("estado (uf)")) return "WZ_UF";

  // se chegou aqui, falta algo fora do previsto
  return "WZ_NOME";
}

async function finishWizardAndGoToDates({ phone, phoneNumberIdFallback, codUsuario, planoKeyFromWizard, traceId = null }) {
  const isRetorno = await versaHadAppointmentLast30Days(codUsuario, {
    traceId,
    tracePhone: maskPhone(phone),
  });

  await updateSession(phone, (s) => {
    s.booking = s.booking || {};
    s.booking.codUsuario = codUsuario;
    s.booking.codColaborador = COD_COLABORADOR;
    s.booking.isRetorno = isRetorno;

    if (planoKeyFromWizard) {
      s.booking.planoKey = planoKeyFromWizard;
    }
  });

  const shown = await showNextDates({
    phone,
    phoneNumberIdFallback,
    codColaborador: COD_COLABORADOR,
    codUsuario,
  });

  if (shown) {
    await setState(phone, "ASK_DATE_PICK");
  }
}
  
// ---- roteamento do wizard por estado ----
if (String(ctx || "").startsWith("WZ_")) {

  // garante estrutura mínima
  let s = await ensureSession(phone);
  if (!s.portal) {
    await updateSession(phone, (sess) => {
      sess.portal = { codUsuario: null, exists: false, profile: null, form: {} };
    });
    s = await ensureSession(phone);
  }
  if (!s.portal.form) {
    await updateSession(phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = {};
    });
    s = await ensureSession(phone);
  }

  // =======================
  // WZ_CPF
  // =======================
if (ctx === "WZ_CPF") {
  const cpf = onlyCpfDigits(raw);

  if (!cpf) {
    await sendText({ to: phone, body: MSG.CPF_INVALIDO, phoneNumberIdFallback });
    return;
  }

  debugLog("PATIENT_CPF_RECEIVED_FOR_IDENTIFICATION", {
    traceId,
    tracePhone: maskPhone(phone),
    cpfMasked: "***",
  });

  let codUsuario = await versaFindCodUsuarioByCPF(cpf);
  if (!codUsuario) {
    codUsuario = await versaFindCodUsuarioByDadosCPF(cpf);
  }

  debugLog("PATIENT_CPF_IDENTIFICATION_RESULT", {
    traceId,
    tracePhone: maskPhone(phone),
    cpfMasked: "***",
    codUsuarioFound: !!codUsuario,
    codUsuario: codUsuario || null,
  });

  if (!codUsuario) {
  await updateSession(phone, (sess) => {
    sess.portal = sess.portal || {};
    sess.portal.form = sess.portal.form || {};
    sess.portal.form.cpf = cpf;
    sess.portal.exists = false;
    sess.portal.codUsuario = null;
  });

  await sendAndSetState(phone, MSG.ASK_NOME, "WZ_NOME", phoneNumberIdFallback);
  return;
}

await updateSession(phone, (sess) => {
  sess.portal = sess.portal || {};
  sess.portal.form = sess.portal.form || {};
  sess.portal.form.cpf = cpf;
  sess.portal.exists = true;
  sess.portal.codUsuario = codUsuario;
});

const prof = await versaGetDadosUsuarioPorCodigo(codUsuario);

await updateSession(phone, (sess) => {
  sess.portal = sess.portal || {};
  sess.portal.profile = prof.ok ? prof.data : null;
});

if (prof.ok && prof.data) {
  const p = prof.data;

  await updateSession(phone, (sess) => {
    sess.portal = sess.portal || {};
    sess.portal.form = sess.portal.form || {};

    const nomeExist = cleanStr(p?.Nome);
    if (nomeExist && !sess.portal.form.nome) sess.portal.form.nome = nomeExist;

    const emailExist = cleanStr(p?.Email);
    if (isValidEmail(emailExist) && !sess.portal.form.email) sess.portal.form.email = emailExist;

    const celExist = cleanStr(p?.Celular).replace(/\D+/g, "");
    if (celExist.length >= 10 && !sess.portal.form.celular) sess.portal.form.celular = celExist;

    const telExist = cleanStr(p?.Telefone).replace(/\D+/g, "");
    if (telExist.length >= 10 && !sess.portal.form.telefone) sess.portal.form.telefone = telExist;

    const cepExist = String(p?.CEP ?? "").replace(/\D+/g, "");
    if (cepExist.length === 8 && !sess.portal.form.cep) sess.portal.form.cep = cepExist;

    const endExist = cleanStr(p?.Endereco);
    if (endExist && !sess.portal.form.endereco) sess.portal.form.endereco = endExist;

    const numExist = cleanStr(p?.Numero);
    if (numExist && !sess.portal.form.numero) sess.portal.form.numero = numExist;

    const compExist = cleanStr(p?.Complemento);
    if (compExist && !sess.portal.form.complemento) sess.portal.form.complemento = compExist;

    const bairroExist = cleanStr(p?.Bairro);
    if (bairroExist && !sess.portal.form.bairro) sess.portal.form.bairro = bairroExist;

    const cidadeExist = cleanStr(p?.Cidade);
    if (cidadeExist && !sess.portal.form.cidade) sess.portal.form.cidade = cidadeExist;

    const dtRaw = cleanStr(p?.DtNasc);
    let dtISO = parseBRDateToISO(dtRaw) || null;

    if (!dtISO) {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dtRaw);
      if (m) dtISO = `${m[1]}-${m[2]}-${m[3]}`;
    }

    if (dtISO && !sess.portal.form.dtNascISO) sess.portal.form.dtNascISO = dtISO;
  });
}  

  if (!prof.ok || !prof.data) {
    await sendText({
      to: phone,
      body: "⚠️ Encontrei seu cadastro, mas não consegui consultar seus dados agora. Por favor, fale com nossa equipe.",
      phoneNumberIdFallback,
    });
    await setState(phone, "MAIN");
    return;
  }

  const sFresh = await ensureSession(phone);

  const v = validatePortalCompleteness(prof.data);
  
  if (v.ok) {
    const flowPlanKey = sFresh?.booking?.planoKey || PLAN_KEYS.PARTICULAR;
    const plansCod = normalizePlanListFromProfile(prof.data);
    const hasFlowPlan = hasPlanKey(plansCod, flowPlanKey);
    const hasMed = hasPlanKey(plansCod, PLAN_KEYS.MEDSENIOR_SP);

    await updateSession(phone, (sess) => {
      sess.booking = sess.booking || {};
      sess.booking.codUsuario = codUsuario;
    });

    if (flowPlanKey === PLAN_KEYS.MEDSENIOR_SP && !hasMed) {
      await updateSession(phone, (sess) => {
        sess.portal = sess.portal || {};
        sess.portal.issue = {
          type: "CONVENIO_NAO_HABILITADO",
          wantedPlan: "MEDSENIOR_SP",
          note: "Cadastro do paciente não possui MedSênior habilitado; necessário atualizar plano no Versatilis.",
          codUsuario: Number(codUsuario) || null,
          plansDetected: Array.isArray(plansCod) ? plansCod.map(Number) : [],
        };
      });

      audit("PLAN_INCONSISTENCY_MEDSENIOR_NOT_ENABLED", {
        traceId,
        tracePhone: maskPhone(phone),
        codUsuario: Number(codUsuario) || null,
        flowPlanKey,
        plansDetected: Array.isArray(plansCod) ? plansCod.map(Number) : [],
        escalationRequired: true,
      });

      await sendButtons({
        to: phone,
        body:
          `Notei que seu cadastro não possui MedSênior habilitado.\n\n` +
          `Para agendar por MedSênior, é necessário regularizar o convênio com nossa equipe.\n\n` +
          `Como deseja prosseguir?`,
        buttons: [
          { id: "PL_USE_PART", title: MSG.BTN_PLAN_PART },
          { id: "FALAR_ATENDENTE", title: MSG.BTN_FALAR_ATENDENTE },
        ],
        phoneNumberIdFallback,
      });

      await setState(phone, "PLAN_PICK");
      return;
    }

    if (hasFlowPlan) {
     await finishWizardAndGoToDates({
        phone,
        phoneNumberIdFallback,
        codUsuario,
        planoKeyFromWizard: flowPlanKey,
        traceId,
      });
      return;
    }

    const buttons = [{ id: "PL_USE_PART", title: MSG.BTN_PLAN_PART }];
    if (hasMed) buttons.push({ id: "PL_USE_MED", title: MSG.BTN_PLAN_MED });

    await sendButtons({
      to: phone,
      body: MSG.PLAN_DIVERGENCIA,
      buttons,
      phoneNumberIdFallback,
    });

    await setState(phone, "PLAN_PICK");
    return;
  }

  await updateSession(phone, (sess) => {
    sess.portal = sess.portal || {};
    sess.portal.missing = v.missing;
  });

  audit("PORTAL_EXISTING_USER_BLOCKED_INCOMPLETE_PROFILE", {
    traceId,
    tracePhone: maskPhone(phone),
    codUsuario: codUsuario || null,
    missingFields: Array.isArray(v.missing) ? v.missing : [],
    escalationRequired: true,
  });

  await sendButtons({
    to: phone,
    body: MSG.PORTAL_EXISTENTE_INCOMPLETO_BLOQUEIO(formatMissing(v.missing)),
    buttons: [{ id: "FALAR_ATENDENTE", title: MSG.BTN_FALAR_ATENDENTE }],
    phoneNumberIdFallback,
  });

  await setState(phone, "BLOCK_EXISTING_INCOMPLETE");
  return;
}
  // =======================
  // WZ_NOME
  // =======================
  if (ctx === "WZ_NOME") {
  const nome = cleanStr(raw);
  if (nome.length < 5) {
    await sendText({ to: phone, body: "⚠️ Envie seu nome completo.", phoneNumberIdFallback });
    return;
  }

  await updateSession(phone, (sess) => {
    sess.portal = sess.portal || {};
    sess.portal.form = sess.portal.form || {};
    sess.portal.form.nome = nome;
  });

  await sendAndSetState(phone, MSG.ASK_DTNASC, "WZ_DTNASC", phoneNumberIdFallback);
  return;
}

  // =======================
  // WZ_DTNASC
  // =======================
  if (ctx === "WZ_DTNASC") {
  const iso = parseBRDateToISO(raw);
  if (!iso) {
    await sendText({ to: phone, body: "⚠️ Data inválida. Use DD/MM/AAAA.", phoneNumberIdFallback });
    return;
  }

  await updateSession(phone, (sess) => {
    sess.portal = sess.portal || {};
    sess.portal.form = sess.portal.form || {};
    sess.portal.form.dtNascISO = iso;
  });

  await sendButtons({
    to: phone,
    body: "Sexo :",
    buttons: [
      { id: "SX_M", title: "Masculino" },
      { id: "SX_F", title: "Feminino" },
      { id: "SX_NI", title: "Prefiro não informar" },
    ],
    phoneNumberIdFallback,
  });
  await setState(phone, "WZ_SEXO");
  return;
}

  // =======================
  // WZ_SEXO
  // =======================
  if (ctx === "WZ_SEXO") {
    await updateSession(phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = sess.portal.form || {};
    
      if (upper === "SX_M") sess.portal.form.sexoOpt = "M";
      else if (upper === "SX_F") sess.portal.form.sexoOpt = "F";
      else sess.portal.form.sexoOpt = "NI";
    });

    await sendButtons({
      to: phone,
      body: "Selecione o convênio para este agendamento:",
      buttons: [
        { id: "PL_PART", title: "Particular" },
        { id: "PL_MED", title: "MedSênior SP" },
      ],
      phoneNumberIdFallback,
    });
    await setState(phone, "WZ_PLANO");
    return;
  }

  // =======================
  // WZ_PLANO
  // =======================
  if (ctx === "WZ_PLANO") {
    if (upper !== "PL_PART" && upper !== "PL_MED") {
      await sendText({ to: phone, body: "Use os botões para selecionar o convênio.", phoneNumberIdFallback });
      return;
    }

    await updateSession(phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = sess.portal.form || {};
      sess.portal.form.planoKey = (upper === "PL_MED") ? "MEDSENIOR_SP" : "PARTICULAR";
      sess.portal.form.celular = formatCellFromWA(phone);
    });
    await sendAndSetState(phone, MSG.ASK_EMAIL, "WZ_EMAIL", phoneNumberIdFallback);
    return;
  }

  // =======================
  // WZ_EMAIL
  // =======================
  if (ctx === "WZ_EMAIL") {
  const email = cleanStr(raw);
  if (!isValidEmail(email)) {
    await sendText({ to: phone, body: "⚠️ E-mail inválido.", phoneNumberIdFallback });
    return;
  }

  await updateSession(phone, (sess) => {
    sess.portal = sess.portal || {};
    sess.portal.form = sess.portal.form || {};
    sess.portal.form.email = email;
  });

  await sendAndSetState(phone, MSG.ASK_CEP, "WZ_CEP", phoneNumberIdFallback);
  return;
}

  // =======================
  // WZ_CEP
  // =======================
  if (ctx === "WZ_CEP") {
    const cep = normalizeCEP(raw);
    if (cep.length !== 8) {
      await sendText({ to: phone, body: "⚠️ CEP inválido. Envie 8 dígitos.", phoneNumberIdFallback });
      return;
    }
    await updateSession(phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = sess.portal.form || {};
      sess.portal.form.cep = cep;
    });
    await sendAndSetState(phone, MSG.ASK_ENDERECO, "WZ_ENDERECO", phoneNumberIdFallback);
    return;
  }

  // =======================
  // WZ_ENDERECO
  // =======================
  if (ctx === "WZ_ENDERECO") {
    const v = cleanStr(raw);
    if (v.length < 3) {
      await sendText({ to: phone, body: "⚠️ Endereço inválido.", phoneNumberIdFallback });
      return;
    }
    await updateSession(phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = sess.portal.form || {};
      sess.portal.form.endereco = v;
    });
    await sendAndSetState(phone, MSG.ASK_NUMERO, "WZ_NUMERO", phoneNumberIdFallback);
    return;
  }

  // =======================
  // WZ_NUMERO
  // =======================
  if (ctx === "WZ_NUMERO") {
    const v = cleanStr(raw);
    if (!v) {
      await sendText({ to: phone, body: "⚠️ Informe o número.", phoneNumberIdFallback });
      return;
    }
    await updateSession(phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = sess.portal.form || {};
      sess.portal.form.numero = v;
    });
    await sendAndSetState(phone, MSG.ASK_COMPLEMENTO, "WZ_COMPLEMENTO", phoneNumberIdFallback);
    return;
  }

  // =======================
  // WZ_COMPLEMENTO
  // =======================
  if (ctx === "WZ_COMPLEMENTO") {
    await updateSession(phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = sess.portal.form || {};
      sess.portal.form.complemento = cleanStr(raw);
    });
    await sendAndSetState(phone, MSG.ASK_BAIRRO, "WZ_BAIRRO", phoneNumberIdFallback);
    return;
  }

  // =======================
  // WZ_BAIRRO
  // =======================
  if (ctx === "WZ_BAIRRO") {
    const v = cleanStr(raw);
    if (!v) {
      await sendText({ to: phone, body: "⚠️ Informe o bairro.", phoneNumberIdFallback });
      return;
    }
    await updateSession(phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = sess.portal.form || {};
      sess.portal.form.bairro = v;
    });
    await sendAndSetState(phone, MSG.ASK_CIDADE, "WZ_CIDADE", phoneNumberIdFallback);
    return;
  }

  // =======================
  // WZ_CIDADE
  // =======================
  if (ctx === "WZ_CIDADE") {
    const v = cleanStr(raw);
    if (!v) {
      await sendText({ to: phone, body: "⚠️ Informe a cidade.", phoneNumberIdFallback });
      return;
    }
    await updateSession(phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = sess.portal.form || {};
      sess.portal.form.cidade = v;
    });
    await sendAndSetState(phone, MSG.ASK_UF, "WZ_UF", phoneNumberIdFallback);
    return;
  }

  // =======================
  // WZ_UF  -> UPSERT + RESET (se novo) + VALIDAR + IR PRA DATAS
  // =======================
  if (ctx === "WZ_UF") {
    const uf = cleanStr(raw).toUpperCase();
    if (!/^[A-Z]{2}$/.test(uf)) {
      await sendText({ to: phone, body: "⚠️ UF inválida. Ex.: SP", phoneNumberIdFallback });
      return;
    }
    const s = await updateSession(phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = sess.portal.form || {};
      sess.portal.form.uf = uf;
    });
    
    const existsCodUsuario = s.portal.exists ? s.portal.codUsuario : null;
    
    const up = await versaUpsertPortalCompleto({
      existsCodUsuario,
      form: s.portal.form,
      traceMeta: {
        traceId,
        tracePhone: maskPhone(phone),
        flow: "PORTAL_WIZARD_CREATE",
      },
    });

    if (!up.ok || !up.codUsuario) {
      await sendText({
        to: phone,
        body: "⚠️ Não consegui atualizar seu cadastro agora. Digite AJUDA para falar com nossa equipe.",
        phoneNumberIdFallback
      });
      await setState(phone, "MAIN");
      return;
    }

    // reset SOMENTE se novo
    if (!existsCodUsuario) {
      let reset = await versaSolicitarSenhaPorCPF(s.portal.form.cpf, s.portal.form.dtNascISO);
      if (!reset?.ok) {
        await new Promise(r => setTimeout(r, 1200));
        reset = await versaSolicitarSenhaPorCPF(s.portal.form.cpf, s.portal.form.dtNascISO);
      }

      audit("PORTAL_NEW_USER_RESET_ATTEMPT", auditOutcome({
        traceId,
        tracePhone: maskPhone(phone),
        technicalAccepted: !!reset?.ok,
        httpStatus: reset?.out?.status || null,
        rid: reset?.out?.rid || null,
        functionalResult: !!reset?.ok ? "UNCONFIRMED_EMAIL_DELIVERY" : "NOT_COMPLETED",
        patientFacingMessage: !!reset?.ok
          ? "RESET_EMAIL_REPORTED_AS_SENT"
          : "RESET_FAILED_NO_PATIENT_MESSAGE_HERE",
        escalationRequired: !reset?.ok,
      }));
    }

    // revalida
    const prof2 = await versaGetDadosUsuarioPorCodigo(up.codUsuario);
    const v2 = prof2.ok ? validatePortalCompleteness(prof2.data) : { ok: false, missing: ["dados do cadastro"] };

    if (!v2.ok) {
      await sendText({ to: phone, body: MSG.PORTAL_NEED_DATA(formatMissing(v2.missing)), phoneNumberIdFallback });

      const next = nextWizardStateFromMissing(v2.missing);
      await setState(phone, next);
      await sendText({ to: phone, body: MSG.ASK_EMAIL, phoneNumberIdFallback }); // fallback simples
      return;
    }

    const sFinal = await ensureSession(phone);

    await finishWizardAndGoToDates({
      phone,
      phoneNumberIdFallback,
      codUsuario: up.codUsuario,
      planoKeyFromWizard: sFinal?.portal?.form?.planoKey,
      traceId,
    });

    return;
  }

  // se cair aqui por algum motivo, volta pro CPF
  await sendAndSetState(phone, MSG.ASK_CPF_PORTAL, "WZ_CPF", phoneNumberIdFallback);
  return;
}
  
  // -------------------
  // CONTEXTO: MAIN
  // -------------------
  if (ctx === "MAIN") {
    if (digits === "1") {
  await setBookingPlan(phone, "PARTICULAR");
  return sendAndSetState(phone, MSG.PARTICULAR, "PARTICULAR", phoneNumberIdFallback);
}
    if (digits === "2") return sendAndSetState(phone, MSG.CONVENIOS, "CONVENIOS", phoneNumberIdFallback);
    if (digits === "3") return sendAndSetState(phone, MSG.POS_MENU, "POS", phoneNumberIdFallback);
    if (digits === "4") return sendAndSetState(phone, MSG.ATENDENTE, "ATENDENTE", phoneNumberIdFallback);
    return sendAndSetState(phone, MSG.MENU, "MAIN", phoneNumberIdFallback);
  }

// -------------------
// CONTEXTO: PARTICULAR
// -------------------
if (ctx === "PARTICULAR") {
  if (digits === "1") {
    await updateSession(phone, (s) => {
      s.booking = {
        ...(s.booking || {}),
        planoKey: PLAN_KEYS.PARTICULAR,
        codColaborador: COD_COLABORADOR,
        codUsuario: null,
        isoDate: null,
        slots: [],
        pageIndex: 0,
        isRetorno: false,
      };

      s.portal = {
        step: "CPF",
        codUsuario: null,
        exists: false,
        profile: null,
        form: {},
      };
    });

    await sendAndSetState(phone, MSG.ASK_CPF_PORTAL, "WZ_CPF", phoneNumberIdFallback);
    return;
  }

  if (digits === "0") return resetToMain(phone, phoneNumberIdFallback);
  return sendAndSetState(phone, MSG.PARTICULAR, "PARTICULAR", phoneNumberIdFallback);
}

  // -------------------
  // CONTEXTO: CONVENIOS
  // -------------------
  if (ctx === "CONVENIOS") {
    if (digits === "0") return resetToMain(phone, phoneNumberIdFallback);

    if (digits === "1") return sendAndSetState(phone, MSG.CONVENIO_GOCARE, "CONV_DETALHE", phoneNumberIdFallback);
    if (digits === "2") return sendAndSetState(phone, MSG.CONVENIO_SAMARITANO, "CONV_DETALHE", phoneNumberIdFallback);
    if (digits === "3") return sendAndSetState(phone, MSG.CONVENIO_SALUSMED, "CONV_DETALHE", phoneNumberIdFallback);
    if (digits === "4") return sendAndSetState(phone, MSG.CONVENIO_PROASA, "CONV_DETALHE", phoneNumberIdFallback);
    if (digits === "5") {
  await setBookingPlan(phone, "MEDSENIOR_SP");
  return sendAndSetState(phone, MSG.MEDSENIOR, "MEDSENIOR", phoneNumberIdFallback);
}


    return sendAndSetState(phone, MSG.CONVENIOS, "CONVENIOS", phoneNumberIdFallback);
  }

  // -------------------
  // CONTEXTO: CONV DETALHE (0 volta ao menu inicial)
  // -------------------
  if (ctx === "CONV_DETALHE") {
    if (digits === "9") return sendAndSetState(phone, MSG.PARTICULAR, "PARTICULAR", phoneNumberIdFallback);
    if (digits === "0") return resetToMain(phone, phoneNumberIdFallback);
    return sendAndSetState(phone, MSG.CONVENIOS, "CONVENIOS", phoneNumberIdFallback);
  }

// -------------------
// CONTEXTO: MEDSENIOR
// -------------------
if (ctx === "MEDSENIOR") {
  if (digits === "1") {
    await updateSession(phone, (s) => {
      // ✅ não apaga o plano do fluxo; garante MedSênior
      s.booking = {
        ...(s.booking || {}),
        planoKey: PLAN_KEYS.MEDSENIOR_SP,
        codColaborador: COD_COLABORADOR,
        codUsuario: null,
        isoDate: null,
        slots: [],
        pageIndex: 0,
        isRetorno: false,
      };

      s.portal = {
        step: "CPF",
        codUsuario: null,
        exists: false,
        profile: null,
        form: {},
      };
    });

    await sendAndSetState(phone, MSG.ASK_CPF_PORTAL, "WZ_CPF", phoneNumberIdFallback);
    return;
  }

  if (digits === "0") return resetToMain(phone, phoneNumberIdFallback);
  return sendAndSetState(phone, MSG.MEDSENIOR, "MEDSENIOR", phoneNumberIdFallback);
}

  // -------------------
  // CONTEXTO: POS
  // -------------------
  if (ctx === "POS") {
    if (digits === "1") return sendAndSetState(phone, MSG.POS_RECENTE, "POS_RECENTE", phoneNumberIdFallback);
    if (digits === "2") return sendAndSetState(phone, MSG.POS_TARDIO, "POS_TARDIO", phoneNumberIdFallback);
    if (digits === "0") return resetToMain(phone, phoneNumberIdFallback);
    return sendAndSetState(phone, MSG.POS_MENU, "POS", phoneNumberIdFallback);
  }

  // -------------------
  // CONTEXTO: POS_RECENTE
  // -------------------
  if (ctx === "POS_RECENTE") {
    if (digits === "0") return resetToMain(phone, phoneNumberIdFallback);
    return sendAndSetState(phone, MSG.POS_RECENTE, "POS_RECENTE", phoneNumberIdFallback);
  }

  // -------------------
  // CONTEXTO: POS_TARDIO
  // -------------------
  if (ctx === "POS_TARDIO") {
    if (digits === "1") return sendAndSetState(phone, MSG.PARTICULAR, "PARTICULAR", phoneNumberIdFallback);
    if (digits === "2") return sendAndSetState(phone, MSG.CONVENIOS, "CONVENIOS", phoneNumberIdFallback);
    if (digits === "0") return resetToMain(phone, phoneNumberIdFallback);
    return sendAndSetState(phone, MSG.POS_TARDIO, "POS_TARDIO", phoneNumberIdFallback);
  }

  // -------------------
  // CONTEXTO: ATENDENTE
  // -------------------
  if (ctx === "ATENDENTE") {
    if (digits === "0") return resetToMain(phone, phoneNumberIdFallback);
    return sendAndSetState(phone, "Por favor, descreva abaixo como podemos te ajudar.", "ATENDENTE", phoneNumberIdFallback);
  }

  // fallback
  return sendAndSetState(phone, MSG.MENU, "MAIN", phoneNumberIdFallback);
}

// =======================
// Health check
// =======================
app.get("/health", (req, res) => res.status(200).send("ok"));

// =======================
// Webhook verification (GET)
// =======================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// =======================
// Webhook receiver (POST)
// =======================
app.post("/webhook", async (req, res) => {
  try {
    res.sendStatus(200);

    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;
    const traceId = crypto.randomUUID();

    const text = (
      msg.text?.body ||
      msg.interactive?.button_reply?.id ||
      ""
    ).trim();

    const phoneNumberIdFallback = value?.metadata?.phone_number_id || "";
    const currentState = (await getState(from)) || "(none)";

    audit("WEBHOOK_INBOUND", {
      traceId,
      phoneMasked: maskPhone(from),
      state: currentState,
      messageHidden: true,
      hasInteractiveReply: !!msg.interactive?.button_reply?.id,
      hasTextBody: !!msg.text?.body,
      phoneNumberIdPresent: !!phoneNumberIdFallback,
    });

    await withPhoneLock(from, async () => {
  await handleInbound(from, text, phoneNumberIdFallback, { traceId });
});
  } catch (err) {
    errLog("WEBHOOK_POST_ERROR", {
      error: String(err?.message || err),
      stackPreview: err?.stack ? String(err.stack).slice(0, 500) : null,
    });
  }
});

// =======================
// PROTEÇÃO GLOBAL PARA /debug
// - debug só existe se ENV permitir
// - e ainda exige DEBUG_KEY
// =======================
function isDebugEnabled() {
  const enabled = String(process.env.ENABLE_DEBUG || "").trim() === "1";
  const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
  return enabled && nodeEnv !== "production";
}

function requireDebugEnabled(req, res, next) {
  if (!isDebugEnabled()) return res.sendStatus(404);
  next();
}

function requireDebugKey(req, res, next) {
  const DEBUG_KEY = process.env.DEBUG_KEY;
  const providedRaw = req.query.k ?? req.headers["x-debug-key"];
  const provided = Array.isArray(providedRaw) ? providedRaw[0] : providedRaw;

  if (!DEBUG_KEY || String(provided || "") !== String(DEBUG_KEY)) {
    return res.status(403).json({ ok: false, error: "forbidden (missing/invalid debug key)" });
  }

  next();
}

function handleDebugRouteError(routeName, e, res, req) {
  errLog("DEBUG_ROUTE_ERROR", {
    routeName,
    method: req?.method || null,
    error: String(e?.message || e),
    stackPreview: e?.stack ? String(e.stack).slice(0, 500) : null,
  });

  return res.status(500).json({
    ok: false,
    routeName,
    error: String(e?.message || e),
  });
}

// Aplica proteção em TODAS as rotas que começam com /debug
app.use("/debug", requireDebugEnabled, requireDebugKey);

app.get("/debug/versatilis/especialidades", async (req, res) => {
  try {
    const out = await versatilisFetch("/api/Especialidade/Especialidades");
    return res.status(200).json(out);
  } catch (e) {
    return handleDebugRouteError("/debug/versatilis/especialidades", e, res, req);
  }
});

app.get("/debug/versatilis/agenda-datas", async (req, res) => {
  try {
    const CodColaborador = req.query.CodColaborador || "3";
    const CodUsuario = req.query.CodUsuario || "17";
    const DataInicial = req.query.DataInicial || "2026-02-24";
    const DataFinal = req.query.DataFinal || "2026-02-24";

    const path =
      `/api/Agenda/Datas?CodColaborador=${encodeURIComponent(CodColaborador)}` +
      `&CodUsuario=${encodeURIComponent(CodUsuario)}` +
      `&DataInicial=${encodeURIComponent(DataInicial)}` +
      `&DataFinal=${encodeURIComponent(DataFinal)}`;

    const out = await versatilisFetch(path);
    return res.status(200).json(out);
  } catch (e) {
    return handleDebugRouteError("/debug/versatilis/agenda-datas", e, res, req);
  }
});

app.get("/debug/versatilis/agenda-consulta", async (req, res) => {
  try {
    const CodColaborador = req.query.CodColaborador || "3";
    const CodUsuario = req.query.CodUsuario || "17";
    const DataInicial = req.query.DataInicial || "2026-02-24";
    const DataFinal = req.query.DataFinal || "2026-02-24";

    const path =
      `/api/Agenda/Datas?CodColaborador=${encodeURIComponent(CodColaborador)}` +
      `&CodUsuario=${encodeURIComponent(CodUsuario)}` +
      `&DataInicial=${encodeURIComponent(DataInicial)}` +
      `&DataFinal=${encodeURIComponent(DataFinal)}`;

    const out = await versatilisFetch(path);

    if (!out.ok || !Array.isArray(out.data)) {
      return res.status(200).json(out);
    }

    const filtered = out.data
      .filter((h) => h && h.PermiteConsulta === true)
      .map((h) => ({
        CodHorario: h.CodHorario,
        Data: h.Data,
        Hora: h.Hora,
        CodUnidade: h.CodUnidade,
        Unidade: h.Unidade,
        CodEspecialidade: h.CodEspecialidade,
        NomeEspecialidade: h.NomeEspecialidade,
        PermiteConsulta: h.PermiteConsulta,
      }));

    return res.status(200).json({ ok: true, status: 200, data: filtered });
  } catch (e) {
    return handleDebugRouteError("/debug/versatilis/agenda-consulta", e, res, req);
  }
});

app.post("/debug/versatilis/confirmar-agendamento", async (req, res) => {
  try {
    
    // Payload (use defaults do seu teste real; pode sobrescrever via body)
    const p = req.body || {};

    const payload = {
  CodUnidade: Number(p.CodUnidade ?? 2),
  CodEspecialidade: Number(p.CodEspecialidade ?? 1003),
  CodPlano: Number(p.CodPlano ?? 2),
  CodHorario: Number(p.CodHorario),
  CodUsuario: Number(p.CodUsuario),
  CodColaborador: Number(p.CodColaborador ?? 3),
  BitTelemedicina: Boolean(p.BitTelemedicina ?? false),
  Confirmada: Boolean(p.Confirmada ?? true),
};

// validações obrigatórias
if (!payload.CodHorario || Number.isNaN(payload.CodHorario)) {
  return res.status(400).json({ ok: false, error: "CodHorario é obrigatório (number)" });
}

    // Opcionais (só envia se vierem)
    if (p.NumCarteirinha) payload.NumCarteirinha = String(p.NumCarteirinha);
    if (p.CodProcedimento != null && p.CodProcedimento !== "") payload.CodProcedimento = Number(p.CodProcedimento);
    if (p.TUSS) payload.TUSS = String(p.TUSS);
    if (p.CodigoVenda != null && p.CodigoVenda !== "") payload.CodigoVenda = Number(p.CodigoVenda);
    if (p.Data) payload.Data = String(p.Data); // use apenas se for testar CodHorario=0 (não recomendo agora)

    // Validação mínima
    if (!payload.CodHorario || Number.isNaN(payload.CodHorario)) {
      return res.status(400).json({ ok: false, error: "CodHorario é obrigatório (number)" });
    }

    // Chamada real
    const out = await versatilisFetch("/api/Agenda/ConfirmarAgendamento", {
      method: "POST",
      jsonBody: payload,
    });

    return res.status(200).json(out);
  } catch (e) {
    return handleDebugRouteError("/debug/versatilis/confirmar-agendamento", e, res, req);
  }
});

app.get("/debug/test-botoes", async (req, res) => {
  try {
    const to = req.query.to; // numero com DDI, ex: 5519XXXXXXXXX
    if (!to) {
      return res.status(400).json({ ok: false, error: "Informe ?to=5519..." });
    }

    await sendButtons({
      to,
      body: "Escolha um horário:",
      buttons: [
        { id: "H_2012", title: "07:30" },
        { id: "H_2013", title: "08:00" },
        { id: "H_2014", title: "08:30" },
      ],
      phoneNumberIdFallback: "",
    });

    return res.json({ ok: true });
  } catch (e) {
    return handleDebugRouteError("/debug/test-botoes",e, res, req);
  }
});

app.get("/debug/redis-ping", async (req, res) => {
  try {
    const key = "health:redis";
    const value = `ok:${Date.now()}`;

    await redis.set(key, value, { ex: 30 }); // expira em 30s
    const read = await redis.get(key);

    return res.status(200).json({ ok: true, wrote: value, read });
  } catch (e) {
    return handleDebugRouteError("/debug/redis-ping", e, res, req);
  }
});

app.get("/debug/versatilis/codusuario", async (req, res) => {
  try {
    const cpf = String(req.query.cpf || "").replace(/\D+/g, "");
    if (cpf.length !== 11) return res.status(400).json({ ok: false, error: "cpf inválido (11 dígitos)" });

    const codUsuario = await versaFindCodUsuarioByCPF(cpf);
    return res.json({ ok: true, cpfMasked: "***", codUsuario });
  } catch (e) {
    return handleDebugRouteError("/debug/versatilis/codusuario", e, res, req);
  }
});

  app.get("/debug/versatilis/options", async (req, res) => {
  try {
    const path = String(req.query.path || "/api/Login/AlterarUsuario");
    const out = await (async () => {
      const token = await versatilisGetToken();
      const url = `${VERSA_BASE}${path}`;
      const r = await fetch(url, { method: "OPTIONS", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      return { ok: r.ok, status: r.status, allow: r.headers.get("allow") || r.headers.get("Allow") || null };
    })();
    return res.json(out);
  } catch (e) {
    return handleDebugRouteError("/debug/versatilis/options", e, res, req);
  }
});
  
// =======================
app.listen(port, () => opLog("SERVER_LISTENING", { port }));
