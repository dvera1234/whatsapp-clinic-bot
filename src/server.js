import express from "express";
import crypto from "crypto";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { getRedisClient } from "./redis.js";

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "too many requests" },
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "too many webhook requests" },
});

const debugLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "too many debug requests" },
});

const app = express();
const port = process.env.PORT || 3000;

app.use(globalLimiter);
app.use("/webhook", webhookLimiter);

app.use(helmet({
  contentSecurityPolicy: false, // API backend, sem necessidade de CSP rígida aqui
  crossOriginEmbedderPolicy: false,
}));

app.disable("x-powered-by");

app.use(express.json({
  limit: "128kb",
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));

app.use(express.urlencoded({ extended: false, limit: "64kb" }));

app.set("trust proxy", 1);

// COMPATIBILIDADE LEGADA EXCLUSIVA DO VERSATILIS:
// o endpoint /api/Login/CadastrarUsuario exige "Senha" em hash MD5,
// conforme manual do fornecedor.
// NÃO reutilizar este helper fora dessa integração específica.
function md5HexLegacyVersatilisOnly(s) {
  return crypto.createHash("md5").update(String(s), "utf8").digest("hex");
}

function generateTempPassword(len = 10) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

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

function maskIp(ip) {
  const s = String(ip || "").trim();
  if (!s) return null;

  if (s.includes(":")) {
    const parts = s.split(":").filter(Boolean);
    if (!parts.length) return "***";
    return `${parts.slice(0, 3).join(":")}:***`;
  }

  const parts = s.split(".");
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.***.***`;
  }

  return "***";
}

function deepSanitizeForLog(value, depth = 0) {
  if (depth > 6) return "[max-depth]";
  if (value == null) return value;

  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return value.map((v) => deepSanitizeForLog(v, depth + 1));
  }

  if (typeof value === "object") {
    const out = {};

    for (const [k, v] of Object.entries(value)) {
      const key = String(k || "").toLowerCase();

      if (
        key.includes("cpf") ||
        key.includes("dtnasc") ||
        key.includes("datanascimento") ||
        key.includes("senha") ||
        key.includes("password") ||
        key.includes("token") ||
        key.includes("authorization") ||
        key.includes("secret") ||
        key.includes("email")
      ) {
        out[k] = "***";
        continue;
      }

      if (
        key.includes("phone") ||
        key.includes("telefone") ||
        key.includes("celular")
      ) {
        out[k] = typeof v === "string" ? maskPhone(v) : "***";
        continue;
      }

      if (key.includes("ip")) {
        out[k] = typeof v === "string" ? maskIp(v) : "***";
        continue;
      }

      out[k] = deepSanitizeForLog(v, depth + 1);
    }

    return out;
  }

  return value;
}

function detectUnexpectedSessionKeys(s) {
  const allowed = new Set([
    "state",
    "lastUserTs",
    "lastPhoneNumberIdFallback",
    "booking",
    "portal",
    "pending",
  ]);

  return Object.keys(s || {}).filter((k) => !allowed.has(k));
}

function sanitizeSessionForSave(s) {
  return {
    state: s?.state ?? null,
    lastUserTs: Number(s?.lastUserTs || 0),
    lastPhoneNumberIdFallback: String(s?.lastPhoneNumberIdFallback || ""),
    booking: s?.booking
      ? {
          planoKey: s.booking?.planoKey ?? null,
          codColaborador: Number(s.booking?.codColaborador || 0) || null,
          codUsuario: Number(s.booking?.codUsuario || 0) || null,
          isoDate: s.booking?.isoDate ?? null,
          pageIndex: Number(s.booking?.pageIndex || 0) || 0,
          slots: Array.isArray(s.booking?.slots)
            ? s.booking.slots
                .map((x) => ({
                  codHorario: Number(x?.codHorario || 0) || null,
                  hhmm: x?.hhmm ?? null,
                }))
                .filter((x) => x.codHorario && x.hhmm)
            : [],
          isRetorno: !!s.booking?.isRetorno,
        }
      : null,
    portal: s?.portal
      ? {
          step: s.portal?.step ?? null,
          codUsuario: Number(s.portal?.codUsuario || 0) || null,
          exists: !!s.portal?.exists,
          form: s.portal?.form ?? {},
          missing: Array.isArray(s.portal?.missing) ? s.portal.missing : [],
          issue: s.portal?.issue ?? null,
        }
      : null,
    pending: s?.pending
      ? {
          codHorario: Number(s.pending?.codHorario || 0) || null,
        }
      : null,
  };
}

function safeJson(obj) {
  try {
    return JSON.stringify(deepSanitizeForLog(obj));
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

opLog("BUILD_INFO", { build: "2026-02-21T20:05 PORTAL-CREATE-ONLY" });

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
const COD_PLANO_PARTICULAR = readPositiveIntEnv("COD_PLANO_PARTICULAR", 0);
const COD_PLANO_MEDSENIOR_SP = readPositiveIntEnv("COD_PLANO_MEDSENIOR_SP", 0);

if (!COD_PLANO_PARTICULAR || !COD_PLANO_MEDSENIOR_SP) {
  throw new Error(
    "ENV obrigatória ausente ou inválida: COD_PLANO_PARTICULAR / COD_PLANO_MEDSENIOR_SP"
  );
}

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

   const r = await fetchWithTimeout(`${VERSA_BASE}/Token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }, 15000);

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

  const r = await fetchWithTimeout(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(jsonBody ? { "Content-Type": "application/json" } : {}),
      ...(extraHeaders ? extraHeaders : {}),
    },
    body: jsonBody ? JSON.stringify(jsonBody) : undefined,
    }, 15000);
  
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
     const ro = await fetchWithTimeout(url, {
        method: "OPTIONS",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      }, 10000);
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

if (isDebugVersaShapeEnabled() && out.ok && out.data && typeof out.data === "object") {
  const keys = Object.keys(out.data || {}).slice(0, 30);
  debugLog("VERSA_CODUSUARIO_SHAPE", {
    path,
    keys,
    isArray: Array.isArray(out.data),
  });
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

  if (!cleanStr(profile?.Nome)) missing.push("nome completo");
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

async function versaCreatePortalCompleto({ form, traceMeta = {} }) {
  const planoKey = form.planoKey;
  const codPlano = resolveCodPlano(planoKey);

  const senhaMD5 = md5HexLegacyVersatilisOnly(generateTempPassword(10));
  const dtNascISO = cleanStr(form.dtNascISO);

  const payload = {
    Nome: form.nome,
    CPF: form.cpf,
    Email: form.email,
    DtNasc: dtNascISO,
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
    Senha: senhaMD5,
  };

  if (form.sexoOpt === "M" || form.sexoOpt === "F") {
    payload.Sexo = form.sexoOpt;
  }

  function isEmpty(v) {
    if (v == null) return true;
    if (typeof v === "string") return v.trim().length === 0;
    if (Array.isArray(v)) return v.length === 0;
    return false;
  }

  const empties = Object.entries(payload)
    .filter(([_, v]) => isEmpty(v))
    .map(([k]) => k);

  const validationErrors = [];

  if (!cleanStr(payload.Nome) || cleanStr(payload.Nome).length < 5) validationErrors.push("Nome");
  if (!/^\d{11}$/.test(String(payload.CPF || "").replace(/\D+/g, ""))) validationErrors.push("CPF");
  if (!isValidEmail(payload.Email)) validationErrors.push("Email");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payload.DtNasc || ""))) validationErrors.push("DtNasc");
  if (!/^\d{8}$/.test(String(payload.CEP || "").replace(/\D+/g, ""))) validationErrors.push("CEP");
  if (!cleanStr(payload.Endereco)) validationErrors.push("Endereco");
  if (!cleanStr(payload.Numero)) validationErrors.push("Numero");
  if (!cleanStr(payload.Bairro)) validationErrors.push("Bairro");
  if (!cleanStr(payload.Cidade)) validationErrors.push("Cidade");
  if (!cleanStr(payload.Celular)) validationErrors.push("Celular");
  if (!cleanStr(payload.Senha)) validationErrors.push("Senha");

  const shape = Object.fromEntries(
    Object.entries(payload).map(([k, v]) => {
      if (typeof v === "string") return [k, `string(len=${v.length})`];
      if (typeof v === "number") return [k, "number"];
      if (Array.isArray(v)) return [k, `array(len=${v.length})`];
      if (typeof v === "boolean") return [k, "boolean"];
      return [k, typeof v];
    })
  );

  debugLog("PORTAL_CREATE_PAYLOAD_SHAPE", {
    empties,
    validationErrors,
    shape,
  });

  if (empties.length > 0 || validationErrors.length > 0) {
    audit("PORTAL_CREATE_BLOCKED_INVALID_PAYLOAD", auditOutcome({
      ...traceMeta,
      technicalAccepted: false,
      functionalResult: "PORTAL_CREATE_BLOCKED_INVALID_PAYLOAD",
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
      validationErrors,
    }));

    return {
      ok: false,
      stage: "blocked_missing_fields",
      missing: empties,
      validationErrors,
      hint: "Wizard não preencheu dados obrigatórios. Corrigir fluxo WZ_*.",
    };
  }

  const out = await versatilisFetch("/api/Login/CadastrarUsuario", {
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

  return {
    ok: true,
    codUsuario: Number.isFinite(Number(codUsuario)) ? Number(codUsuario) : null,
  };
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

function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`ENV obrigatória ausente: ${name}`);
  }
  return value;
}

requireEnv("VERIFY_TOKEN");
requireEnv("WHATSAPP_TOKEN");
requireEnv("VERSATILIS_BASE");
requireEnv("VERSATILIS_USER");
requireEnv("VERSATILIS_PASS");
requireEnv("UPSTASH_REDIS_REST_URL");
requireEnv("UPSTASH_REDIS_REST_TOKEN");
const APP_SECRET = requireEnv("APP_SECRET");

opLog("ENV_CHECK", {
  hasWhatsAppToken: !!pickToken(),
  hasVerifyToken: !!process.env.VERIFY_TOKEN,
  hasFlowResetCode: !!String(process.env.FLOW_RESET_CODE || "").trim(),
});

// =======================
// CONFIG
// =======================
const INACTIVITY_WARN_MS = (14 * 60 * 1000) + (50 * 1000); // 14m50s
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 900); // 15 min (900s)

  // =======================
// DEBUG REDIS (controla logs de GET/SET)
// =======================
const DEBUG_REDIS = String(process.env.DEBUG_REDIS || "0").trim() === "1";

function logRedis(tag, obj) {
  if (!DEBUG_REDIS) return;
  safeConsoleWrite(`[${tag}] ${safeJson(obj)}`);
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
const COD_UNIDADE = readPositiveIntEnv("COD_UNIDADE", 0);
const COD_ESPECIALIDADE = readPositiveIntEnv("COD_ESPECIALIDADE", 0);
const COD_COLABORADOR = readPositiveIntEnv("COD_COLABORADOR", 0);

if (!COD_UNIDADE || !COD_ESPECIALIDADE || !COD_COLABORADOR) {
  throw new Error(
    "ENV obrigatória ausente ou inválida: COD_UNIDADE / COD_ESPECIALIDADE / COD_COLABORADOR"
  );
}

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

  const unexpectedKeys = detectUnexpectedSessionKeys(sessionObj);
  if (unexpectedKeys.length) {
    techLog("SESSION_UNEXPECTED_KEYS_DROPPED", {
      phoneMasked: maskPhone(phone),
      unexpectedKeys: unexpectedKeys.slice(0, 20),
    });
  }

  const safeSession = sanitizeSessionForSave(sessionObj);
  const val = JSON.stringify(safeSession);

  logRedis("REDIS_SET", {
    phone: maskPhone(phone),
    key: maskKey(key),
    len: val.length
  });

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
  const s = await updateSession(phone, (sess) => {
    sess.lastUserTs = Date.now();
    if (phoneNumberIdFallback) sess.lastPhoneNumberIdFallback = phoneNumberIdFallback;
  });

  scheduleInactivityWarning(phone, phoneNumberIdFallback);
  return s;
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
  clearInactivityTimer(phone);
  await deleteSession(phone);
}

function clearInactivityTimer(phone) {
  const key = String(phone || "").replace(/\D+/g, "");
  const timer = inactivityTimers.get(key);

  if (timer) {
    clearTimeout(timer);
    inactivityTimers.delete(key);
  }
}

function scheduleInactivityWarning(phone, phoneNumberIdFallback) {
  const key = String(phone || "").replace(/\D+/g, "");
  if (!key) return;

  clearInactivityTimer(key);

  const timer = setTimeout(async () => {
    try {
      const s = await loadSession(key);

      if (!s) {
        inactivityTimers.delete(key);
        return;
      }

      const idleMs = Date.now() - Number(s.lastUserTs || 0);

      // Só envia se realmente ainda estiver inativo próximo do TTL
      if (idleMs < INACTIVITY_WARN_MS - 2000) {
        inactivityTimers.delete(key);
        return;
      }

      await sendText({
        to: key,
        body: MSG.ENCERRAMENTO,
        phoneNumberIdFallback: s.lastPhoneNumberIdFallback || phoneNumberIdFallback || "",
      });

      await clearSession(key);
      inactivityTimers.delete(key);

      audit("FLOW_INACTIVITY_TIMEOUT", {
        tracePhone: maskPhone(key),
        inactivityMs: idleMs,
        ttlSeconds: SESSION_TTL_SECONDS,
        warningMs: INACTIVITY_WARN_MS,
        functionalResult: "SESSION_CLEARED_AFTER_INACTIVITY",
        patientFacingMessage: "INACTIVITY_CLOSURE_MESSAGE_SENT",
        escalationRequired: false,
      });
    } catch (e) {
      inactivityTimers.delete(key);

      errLog("FLOW_INACTIVITY_TIMEOUT_ERROR", {
        tracePhone: maskPhone(key),
        error: String(e?.message || e),
      });
    }
  }, INACTIVITY_WARN_MS);

  inactivityTimers.set(key, timer);
}

// =======================
// CONTATO SUPORTE (link clicável)
// =======================
const SUPPORT_WA = "5519933005596";

// =======================
// PORTAL DO PACIENTE (ENV) — GLOBAL
// =======================
function normalizeHttpsUrlOrEmpty(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return "";
    return u.toString();
  } catch {
    return "";
  }
}

const PORTAL_URL = normalizeHttpsUrlOrEmpty(process.env.PORTAL_URL);

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

// ✅ NOVO: Bloqueio formal para paciente EXISTENTE com cadastro incompleto
PORTAL_EXISTENTE_INCOMPLETO_BLOQUEIO: (faltas) =>
  `Encontrei seu cadastro ✅, porém ele está incompleto no Portal do Paciente.\n\nPor segurança, o agendamento por aqui fica bloqueado neste caso.\n\nFaltam:\n${faltas}\n\n✅  Precisaria entrar em contato com um atendente para regularizar seu cadastro.`,

// ✅ NOVO: texto do botão único
BTN_FALAR_ATENDENTE: `Falar com atendente`,

ASK_NOME: `Informe seu nome completo:`,
ASK_DTNASC: `Informe sua data de nascimento (DD/MM/AAAA):`,
ASK_SEXO: `Selecione seu sexo:`,
ASK_EMAIL: `Informe seu e-mail:`,
ASK_CEP: `Informe seu CEP (somente números):`,
ASK_ENDERECO: `Informe seu endereço (logradouro):`,
ASK_NUMERO: `Número:`,
ASK_COMPLEMENTO: `Complemento (se não tiver, envie apenas 0):`,
ASK_BAIRRO: `Bairro:`,
ASK_CIDADE: `Cidade:`,
ASK_UF: `Estado (UF), ex.: SP:`,

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
  REDIS_UNAVAILABLE: `⚠️ Ocorreu uma instabilidade temporária no atendimento.

Por favor, envie novamente sua mensagem em instantes para reiniciar o fluxo com segurança.`,
};


// =======================
// HELPERS
// =======================
function stripControlChars(s) {
  return String(s || "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

function normalizeHumanText(s, maxLen = 120) {
  return stripControlChars(s).replace(/\s+/g, " ").slice(0, maxLen);
}

function isValidName(s) {
  const v = normalizeHumanText(s, 120);
  return (
    v.length >= 5 &&
    /^[A-Za-zÀ-ÿ'´`.-]+(?:\s+[A-Za-zÀ-ÿ'´`.-]+)+$/.test(v)
  );
}

function isValidSimpleAddressField(s, min = 2, max = 120) {
  const v = normalizeHumanText(s, max);
  return v.length >= min;
}

async function clearTransientPortalData(phone) {
  await updateSession(phone, (s) => {
    if (!s?.portal) return;

    s.portal.form = {};
    delete s.portal.missing;
    delete s.portal.issue;
  });
}

function auditVersaDivergence(payload = {}) {
  audit("VERSATILIS_MANUAL_TENANT_DIVERGENCE", {
    ...payload,
  });
}

function getPromptByWizardState(state) {
  switch (state) {
    case "WZ_NOME": return MSG.ASK_NOME;
    case "WZ_DTNASC": return MSG.ASK_DTNASC;
    case "WZ_EMAIL": return MSG.ASK_EMAIL;
    case "WZ_CEP": return MSG.ASK_CEP;
    case "WZ_ENDERECO": return MSG.ASK_ENDERECO;
    case "WZ_NUMERO": return MSG.ASK_NUMERO;
    case "WZ_COMPLEMENTO": return MSG.ASK_COMPLEMENTO;
    case "WZ_BAIRRO": return MSG.ASK_BAIRRO;
    case "WZ_CIDADE": return MSG.ASK_CIDADE;
    case "WZ_UF": return MSG.ASK_UF;
    default: return MSG.ASK_NOME;
  }
}

function bookingConfirmKey(phone, codHorario) {
  const p = String(phone || "").replace(/\D+/g, "");
  return `booking:confirm:${p}:${codHorario}`;
}

const inboundLocks = new Map();
const inactivityTimers = new Map();

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (e) {
    if (e?.name === "AbortError") {
      throw new Error(`Fetch timeout after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function isDuplicateWebhookMessage(messageId) {
  const id = String(messageId || "").trim();
  if (!id) return false;

  const key = `wa:msg:${id}`;
  const created = await redis.set(key, "1", { ex: 300, nx: true });

  return !created;
}

function isRedisError(err) {
  const msg = String(err?.message || err || "").toLowerCase();

  return (
    msg.includes("redis") ||
    msg.includes("upstash") ||
    msg.includes("connect") ||
    msg.includes("connection") ||
    msg.includes("socket") ||
    msg.includes("timeout") ||
    msg.includes("network") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("fetch failed")
  );
}

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

async function runWithSafeSession(phone, phoneNumberIdFallback, traceId, fn) {
  try {
    return await fn();
  } catch (e) {
    if (!isRedisError(e)) {
      throw e;
    }

    errLog("REDIS_SAFE_RESTART_TRIGGERED", {
      traceId: traceId || null,
      tracePhone: maskPhone(phone),
      error: String(e?.message || e),
    });

    try {
      await sendText({
        to: phone,
        body: MSG.REDIS_UNAVAILABLE,
        phoneNumberIdFallback,
      });
    } catch {}

    try {
      await deleteSession(phone);
    } catch {}

    return null;
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

async function sendSupportLink({ phone, phoneNumberIdFallback, prefill, nextState = "MAIN" }) {
  const link = makeWaLink(prefill);

  await sendText({
    to: phone,
    body: `✅ Para falar com nossa equipe, clique no link abaixo e envie a mensagem:\n\n${link}`,
    phoneNumberIdFallback,
  });

  if (nextState) {
    await setState(phone, nextState);
  }
}

function buildSupportPrefillFromSession(phone, s, traceId = null) {
  const faltas = Array.isArray(s?.portal?.missing) ? s.portal.missing : [];
  const issue = s?.portal?.issue || null;

  const motivo =
    issue?.type === "CONVENIO_NAO_HABILITADO"
      ? "Convênio desejado não habilitado no cadastro."
      : "Ajuda no agendamento.";

  return buildSafeSupportPrefill({
    traceId,
    phone,
    reason: motivo,
    missing: faltas,
  });
}

function toHHMM(hora) {
  const s = String(hora || "").trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return null;
  const hh = String(Number(m[1])).padStart(2, "0");
  return `${hh}:${m[2]}`;
}

function buildSafeSupportPrefill({
  traceId = null,
  phone = "",
  reason = "",
  details = "",
  missing = [],
}) {
  const lines = [
    "Olá! Preciso de ajuda no agendamento.",
    "",
    `TraceId: ${traceId || "(não informado)"}`,
    `Paciente: ${maskPhone(phone)}`,
    `Motivo: ${reason || "Ajuda no agendamento."}`,
  ];

  if (details) {
    lines.push(`Detalhes: ${String(details).slice(0, 200)}`);
  }

  if (Array.isArray(missing) && missing.length) {
    lines.push(`Pendências: ${missing.join(", ")}`);
  }

  return lines.join("\n").trim();
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

  const resp = await fetchWithTimeout(config.url, {
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
  }, 15000);

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    errLog("WHATSAPP_SEND_TEXT_FAIL", {
      phoneMasked: maskPhone(to),
      httpStatus: resp.status,
      responseBodyPresent: !!txt,
      responseBodyLen: txt ? String(txt).length : 0,
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

  const resp = await fetchWithTimeout(config.url, {
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
  }, 15000);

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    errLog("WHATSAPP_SEND_BUTTONS_FAIL", {
      phoneMasked: maskPhone(to),
      httpStatus: resp.status,
      responseBodyPresent: !!txt,
      responseBodyLen: txt ? String(txt).length : 0,
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

  if (!sent) {
    errLog("FLOW_STATE_TRANSITION_ABORTED_SEND_FAIL", {
      phoneMasked: maskPhone(phone),
      targetState: state || null,
      outboundMessageLength: String(body || "").length,
    });
    return false;
  }

  if (state) {
    await setState(phone, state);

    const back = await getState(phone);
    debugLog("FLOW_STATE_TRANSITION", {
      phoneMasked: maskPhone(phone),
      targetState: state,
      readbackState: back || "(none)",
      outboundMessageSent: true,
      outboundMessageLength: String(body || "").length,
    });
  }

  return true;
}

// =======================
// RESET LIMPO PARA MAIN (limpa pendências antigas)
// =======================
async function resetToMain(phone, phoneNumberIdFallback) {
  await updateSession(phone, (s) => {
    if (s?.portal) {
      s.portal.form = {};
      delete s.portal.issue;
      delete s.portal.missing;
    }
    if (s?.pending) delete s.pending;
  });

  await sendAndSetState(phone, MSG.MENU, "MAIN", phoneNumberIdFallback);
}

// Inatividade:
// - Redis TTL (15 min) é a regra oficial de expiração da sessão.
// - Um timer local envia MSG.ENCERRAMENTO em 14m50s como best effort.
// - Se o timer falhar (restart/deploy/etc.), o Redis continua encerrando a sessão corretamente.

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
  const prefill = buildSupportPrefillFromSession(phone, s, traceId);

  await sendSupportLink({
    phone,
    phoneNumberIdFallback,
    prefill,
    nextState: "MAIN",
  });
  
  await clearTransientPortalData(phone);
  return;
  }
  
  const ctx = (await getState(phone)) || "MAIN";
  
// =======================
// BLOQUEIO FORMAL: PACIENTE EXISTENTE COM CADASTRO INCOMPLETO
// ÚNICA OPÇÃO = HUMANO
// =======================
if (ctx === "BLOCK_EXISTING_INCOMPLETE") {
  const s = await ensureSession(phone);
  const faltas = Array.isArray(s?.portal?.missing) ? s.portal.missing : [];

  const prefill = buildSafeSupportPrefill({
    traceId,
    phone,
    reason: "Cadastro incompleto no Portal do Paciente.",
    missing: faltas,
  });

  await sendSupportLink({
    phone,
    phoneNumberIdFallback,
    prefill,
    nextState: "MAIN",
  });

  await clearTransientPortalData(phone);
  return;
}

if (ctx === "PLAN_PICK") {
  if (upper === "FALAR_ATENDENTE") {
    const s = await ensureSession(phone);
    const prefill = buildSupportPrefillFromSession(phone, s, traceId);

    await sendSupportLink({
      phone,
      phoneNumberIdFallback,
      prefill,
      nextState: "MAIN",
    });

    await clearTransientPortalData(phone);
    return;
  }

  if (upper !== "PL_USE_PART" && upper !== "PL_USE_MED") {
    await sendText({
      to: phone,
      body: "Use os botões apresentados para prosseguir.",
      phoneNumberIdFallback,
    });
    return;
  }

  const chosenKey =
    upper === "PL_USE_MED" ? PLAN_KEYS.MEDSENIOR_SP : PLAN_KEYS.PARTICULAR;

  await updateSession(phone, (sess) => {
    sess.booking = sess.booking || {};
    sess.booking.planoKey = chosenKey;

    if (sess.portal && sess.portal.issue) {
      delete sess.portal.issue;
    }
  });

  const s = await ensureSession(phone);
  const codUsuario = Number(s?.booking?.codUsuario || s?.portal?.codUsuario);

  if (!codUsuario) {
    await sendText({
      to: phone,
      body: "⚠️ Sessão inválida. Digite 1 para iniciar novamente.",
      phoneNumberIdFallback,
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

    await updateSession(phone, (sess) => {
      sess.booking = sess.booking || {};
      sess.booking.pageIndex = Number.isFinite(n) && n >= 0 ? n : 0;
    });

    const s = await ensureSession(phone);
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

const isParticularBooking = Number(payload.CodPlano) === Number(COD_PLANO_PARTICULAR);
const isRetornoBooking = !!s?.booking?.isRetorno;

const showPagamentoInfo = isParticularBooking && !isRetornoBooking;

const PAGAMENTO_INFO = showPagamentoInfo
  ? `

💳 *Pagamento da consulta*
Após realizar o check-in no totem, efetue o pagamento antes do atendimento.`
  : "";

const ORIENTACOES = `⏰ *Chegada*
Recomendamos que chegue com 15 minutos de antecedência.

🛋️ *Conforto*
Nossa sala de espera foi pensada com carinho para seu conforto: ambiente acolhedor, água disponível, Wi-Fi gratuito e honest market com opções variadas.

🚗 *Estacionamento*
Há estacionamento com valet no prédio.

📍 *Ao chegar*
Leve um documento oficial com foto para realizar seu cadastro na recepção do edifício e dirija-se ao 6º andar. Ao chegar, identifique-se no totem de atendimento.${PAGAMENTO_INFO}`;

    const PORTAL_INFO = `📲 Conheça o Portal do Paciente

No Portal, você pode:
• Consultar e atualizar seus dados cadastrais
• Acompanhar seus agendamentos
• Acessar informações e serviços disponíveis

🔑 Acesso ao Portal
Se você ainda não tiver senha ou não se lembrar dela,
acesse o Portal e selecione a opção “Esqueci minha senha”.`;

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
    const prefill = buildSafeSupportPrefill({
      traceId,
      phone,
      reason: "Paciente relatou dificuldade no agendamento.",
      details: raw,
    });
  
    await sendSupportLink({
      phone,
      phoneNumberIdFallback,
      prefill,
      nextState: "MAIN",
    });
  
    await clearTransientPortalData(phone);
    return;
  }

 // Texto livre: se estiver em ATENDENTE, gera link com a mensagem
// ⚠️ NÃO aplicar fallback enquanto estiver em wizard WZ_*
if (!digits && !String(ctx || "").startsWith("WZ_")) {
  if (ctx === "ATENDENTE") {
  const prefill = buildSafeSupportPrefill({
    traceId,
    phone,
    reason: "Paciente solicitou atendimento humano.",
    details: raw,
  });

  await sendSupportLink({
    phone,
    phoneNumberIdFallback,
    prefill,
    nextState: "MAIN",
  });

  await clearTransientPortalData(phone);
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
      sess.portal = { codUsuario: null, exists: false, form: {} };
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
    const prefill = buildSafeSupportPrefill({
      traceId,
      phone,
      reason: "Paciente sem cadastro localizável automaticamente no sistema.",
    });
  
    const link = makeWaLink(prefill);
  
    await sendText({
      to: phone,
      body: `⚠️ Não consegui localizar seu cadastro automaticamente.\n\n✅ Para prosseguir com segurança, fale com nossa equipe:\n${link}`,
      phoneNumberIdFallback,
    });
  
    await clearTransientPortalData(phone);
    await setState(phone, "MAIN");
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

  const v = validatePortalCompleteness(prof.data);

  if (v.ok) {
    const sCurrent = await ensureSession(phone);
    const flowPlanKey = sCurrent?.booking?.planoKey || PLAN_KEYS.PARTICULAR;
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
  const nome = normalizeHumanText(raw, 120);

  if (!isValidName(nome)) {
    await sendText({
      to: phone,
      body: "⚠️ Envie seu nome completo.",
      phoneNumberIdFallback
    });
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
  const v = normalizeHumanText(raw, 120);

  if (!isValidSimpleAddressField(v, 3, 120)) {
    await sendText({
      to: phone,
      body: "⚠️ Endereço inválido.",
      phoneNumberIdFallback
    });
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
  const v = normalizeHumanText(raw, 20);

  if (!v) {
    await sendText({
      to: phone,
      body: "⚠️ Informe o número.",
      phoneNumberIdFallback
    });
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
  const v = normalizeHumanText(raw, 80) || "0";

  await updateSession(phone, (sess) => {
    sess.portal = sess.portal || {};
    sess.portal.form = sess.portal.form || {};
    sess.portal.form.complemento = v;
  });

  await sendAndSetState(phone, MSG.ASK_BAIRRO, "WZ_BAIRRO", phoneNumberIdFallback);
  return;
}

  // =======================
  // WZ_BAIRRO
  // =======================
  if (ctx === "WZ_BAIRRO") {
  const v = normalizeHumanText(raw, 80);

  if (!isValidSimpleAddressField(v, 2, 80)) {
    await sendText({
      to: phone,
      body: "⚠️ Informe o bairro.",
      phoneNumberIdFallback
    });
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
  const v = normalizeHumanText(raw, 80);

  if (!isValidSimpleAddressField(v, 2, 80)) {
    await sendText({
      to: phone,
      body: "⚠️ Informe a cidade.",
      phoneNumberIdFallback
    });
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
// WZ_UF  -> CREATE + VALIDAR + IR PRA DATAS
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
    
    const up = await versaCreatePortalCompleto({
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
        body: "⚠️ Não consegui concluir seu cadastro agora. Digite AJUDA para falar com nossa equipe.",
        phoneNumberIdFallback
      });
      await setState(phone, "MAIN");
      return;
    }

    // revalida
    const prof2 = await versaGetDadosUsuarioPorCodigo(up.codUsuario);
    const v2 = prof2.ok ? validatePortalCompleteness(prof2.data) : { ok: false, missing: ["dados do cadastro"] };

    if (!v2.ok) {
      await sendText({
        to: phone,
        body: MSG.PORTAL_NEED_DATA(formatMissing(v2.missing)),
        phoneNumberIdFallback,
      });
    
      const next = nextWizardStateFromMissing(v2.missing);
      await setState(phone, next);
    
      await sendText({
        to: phone,
        body: getPromptByWizardState(next),
        phoneNumberIdFallback,
      });
      return;
    }

    const sFinal = await ensureSession(phone);

    const planoKeyFinal = sFinal?.portal?.form?.planoKey;

    await clearTransientPortalData(phone);
    
    await finishWizardAndGoToDates({
      phone,
      phoneNumberIdFallback,
      codUsuario: up.codUsuario,
      planoKeyFromWizard: planoKeyFinal,
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
    if (!isValidMetaSignature(req)) {
      audit("WEBHOOK_INVALID_SIGNATURE", {
        ipMasked: maskIp(req.ip),
        hasSignatureHeader: !!req.headers["x-hub-signature-256"],
      });
      return res.sendStatus(403);
    }

    res.sendStatus(200);

    const body = req.body;

    if (!body || body.object !== "whatsapp_business_account") return;
    
    const entry = body.entry?.[0];
    if (!entry || !Array.isArray(entry.changes) || entry.changes.length === 0) {
      audit("WEBHOOK_INVALID_SHAPE", {
        ipMasked: maskIp(req.ip),
        hasBody: !!body,
      });
      return;
    }
    
    const change = entry.changes[0];
    if (!change || change.field !== "messages" || !change.value || typeof change.value !== "object") {
      audit("WEBHOOK_INVALID_CHANGE_SHAPE", {
        ipMasked: maskIp(req.ip),
      });
      return;
    }
    
    const value = change.value;
    const msg = value?.messages?.[0];
    if (!msg) return;
    
    const from = msg.from;
    const traceId = crypto.randomUUID();
    const messageId = msg.id || null;
    
    if (await isDuplicateWebhookMessage(messageId)) {
      audit("WEBHOOK_DUPLICATE_IGNORED", {
        traceId,
        phoneMasked: maskPhone(from),
      });
      return;
    }
    
    let text = (
      msg.text?.body ||
      msg.interactive?.button_reply?.id ||
      ""
    ).trim();
    
    if (text.length > 500) {
      text = text.slice(0, 500);
    }
    
    if (!text) {
      audit("WEBHOOK_IGNORED_EMPTY_MESSAGE", {
        traceId,
        phoneMasked: maskPhone(from),
      });
      return;
    }

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
      await runWithSafeSession(from, phoneNumberIdFallback, traceId, async () => {
        await handleInbound(from, text, phoneNumberIdFallback, { traceId });
      });
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

  return enabled && (nodeEnv === "development" || nodeEnv === "test");
}

function isDebugVersaShapeEnabled() {
  return isDebugEnabled() && String(process.env.DEBUG_VERSA_SHAPE || "").trim() === "1";
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");

  const max = Math.max(aa.length, bb.length, 1);
  const pa = Buffer.alloc(max);
  const pb = Buffer.alloc(max);

  aa.copy(pa);
  bb.copy(pb);

  const same = crypto.timingSafeEqual(pa, pb);
  return same && aa.length === bb.length;
}

function isValidMetaSignature(req) {
  const signatureHeader = req.headers["x-hub-signature-256"];

  if (!signatureHeader || !req.rawBody) {
    return false;
  }

  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", APP_SECRET)
      .update(req.rawBody)
      .digest("hex");

  return safeEqual(String(signatureHeader), expected);
}

function requireDebugKey(req, res, next) {
  const DEBUG_KEY = process.env.DEBUG_KEY;
  const providedRaw = req.headers["x-debug-key"];
  const provided = Array.isArray(providedRaw) ? providedRaw[0] : providedRaw;

  if (!DEBUG_KEY || !safeEqual(provided, DEBUG_KEY)) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }

  next();
}

function normalizeDigits(s) {
  return String(s || "").replace(/\D+/g, "");
}

function isAllowedDebugPhone(phone) {
  const allowed = normalizeDigits(process.env.DEBUG_ALLOWED_PHONE || "");
  const got = normalizeDigits(phone || "");
  return !!allowed && got === allowed;
}

function handleDebugRouteError(routeName, e, res, req) {
  errLog("DEBUG_ROUTE_ERROR", {
    routeName,
    method: req?.method || null,
    error: String(e?.message || e),
    stackPresent: !!e?.stack,
  });

  return res.status(500).json({
    ok: false,
    routeName,
    error: "internal debug route error",
  });
}

function buildSafeDebugVersaResponse(out) {
  return {
    ok: !!out?.ok,
    status: out?.status ?? null,
    rid: out?.rid ?? null,
    allow: out?.allow ?? null,
    dataType:
      Array.isArray(out?.data) ? "array" :
      out?.data === null ? "null" :
      typeof out?.data,
    isArray: Array.isArray(out?.data),
    arrayLength: Array.isArray(out?.data) ? out.data.length : null,
    topLevelKeys:
      out?.data &&
      typeof out.data === "object" &&
      !Array.isArray(out.data)
        ? Object.keys(out.data).slice(0, 8)
        : null,
  };
}

if (isDebugEnabled()) {
  app.use("/debug", debugLimiter);
  
  app.use("/debug", (req, res, next) => {
    const allowed = new Set(["GET", "POST"]);
    if (!allowed.has(req.method)) {
      return res.status(405).json({ ok: false, error: "method not allowed" });
    }
    next();
  });

  // Aplica proteção em TODAS as rotas que começam com /debug
  app.use("/debug", requireDebugKey);

  app.get("/debug/versatilis/especialidades", async (req, res) => {
    try {
      const out = await versatilisFetch("/api/Especialidade/Especialidades");
      return res.status(200).json(buildSafeDebugVersaResponse(out));
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
      return res.status(200).json(buildSafeDebugVersaResponse(out));
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
        return res.status(200).json(buildSafeDebugVersaResponse(out));
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
  
      if (!payload.CodHorario || Number.isNaN(payload.CodHorario)) {
        return res.status(400).json({ ok: false, error: "CodHorario é obrigatório (number)" });
      }
  
      if (!payload.CodUsuario || Number.isNaN(payload.CodUsuario)) {
        return res.status(400).json({ ok: false, error: "CodUsuario é obrigatório (number)" });
      }
  
      if (p.NumCarteirinha) payload.NumCarteirinha = String(p.NumCarteirinha);
      if (p.CodProcedimento != null && p.CodProcedimento !== "") payload.CodProcedimento = Number(p.CodProcedimento);
      if (p.TUSS) payload.TUSS = String(p.TUSS);
      if (p.CodigoVenda != null && p.CodigoVenda !== "") payload.CodigoVenda = Number(p.CodigoVenda);
      if (p.Data) payload.Data = String(p.Data);
  
      const out = await versatilisFetch("/api/Agenda/ConfirmarAgendamento", {
        method: "POST",
        jsonBody: payload,
      });
  
      return res.status(200).json(buildSafeDebugVersaResponse(out));
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
      
      if (!isAllowedDebugPhone(to)) {
        return res.status(403).json({ ok: false, error: "debug target not allowed" });
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
  
      await redis.set(key, value, { ex: 30 });
      const read = await redis.get(key);
  
      return res.status(200).json({
        ok: true,
        redisWriteOk: true,
        redisReadOk: read === value,
      });
    } catch (e) {
      return handleDebugRouteError("/debug/redis-ping", e, res, req);
    }
  });

  app.get("/debug/versatilis/codusuario", async (req, res) => {
    try {
      const cpf = String(req.query.cpf || "").replace(/\D+/g, "");
      if (cpf.length !== 11) {
        return res.status(400).json({ ok: false, error: "cpf inválido (11 dígitos)" });
      }
  
      const codUsuario = await versaFindCodUsuarioByCPF(cpf);
      return res.json({
        ok: true,
        cpfMasked: "***",
        found: !!codUsuario,
      });
    } catch (e) {
      return handleDebugRouteError("/debug/versatilis/codusuario", e, res, req);
    }
  });
}
  
// =======================
app.use((err, req, res, next) => {
  errLog("UNHANDLED_SERVER_ERROR", {
    route: req.originalUrl || req.url || null,
    method: req.method || null,
    ipMasked: maskIp(req.ip),
    error: String(err?.message || err),
    stackPreview: err?.stack ? String(err.stack).slice(0, 500) : null,
  });

  return res.sendStatus(500);
});

app.use((req, res) => {
  res.sendStatus(404);
});

app.listen(port, () => opLog("SERVER_LISTENING", { port }));
