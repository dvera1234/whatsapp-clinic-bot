import express from "express";
import crypto from "crypto";

console.log("[BUILD]", "2026-02-21T19:xx PUT-FIX-1");

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

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
// VERSATILIS (fetch) — helper mínimo e seguro
// =======================
const VERSA_BASE = process.env.VERSATILIS_BASE; // ex: https://sistema.versatilis.com.br/DraNellieRubio
const VERSA_USER = process.env.VERSATILIS_USER;
const VERSA_PASS = process.env.VERSATILIS_PASS;

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

  console.log("[VERSATILIS] token ok", { token: maskToken(versaToken) });
  return versaToken;
}

async function versatilisFetch(path, { method = "GET", jsonBody } = {}) {
  const token = await versatilisGetToken();

  const rid = crypto.randomUUID();
  const url = `${VERSA_BASE}${path}`;

  // LOG ANTES DO FETCH
  console.log("[VERSATILIS OUT]", {
    rid,
    method,
    url,
    hasBody: !!jsonBody,
  });

  if (path === "/api/Login/AlterarUsuario" && method !== "PUT") {
    console.log("[VERSATILIS GUARD] ALTERAR USUARIO method errado!", {
      rid,
      method,
    });
  }

  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(jsonBody ? { "Content-Type": "application/json" } : {}),
    },
    body: jsonBody ? JSON.stringify(jsonBody) : undefined,
  });

  const text = await r.text().catch(() => "");
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  // LOG DEPOIS DO FETCH
  console.log("[VERSATILIS IN]", {
    rid,
    method,
    path,
    status: r.status,
  });

  return { ok: r.ok, status: r.status, data, rid };
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
  console.log("[VERSA] CodUsuario shape keys (top)", { path, keys, isArray: Array.isArray(out.data) });
}
    
    const parsed = out.ok ? parseCodUsuarioFromAny(out.data) : null;

    console.log("[VERSA] CodUsuario try", {
      ok: out.ok,
      status: out.status,
      path,
      parsed: parsed ? "OK" : "null",
      dataType: typeof out.data,
    });

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

  console.log("[VERSA] CodUsuario try", {
    ok: out.ok,
    status: out.status,
    path,
    parsed: parsed ? "OK" : "null",
    dataType: typeof out.data,
  });

  if (parsed) return parsed;
}

// 🔒 FALLBACK seguro pelo endpoint oficial do manual
const byDados = await versaFindCodUsuarioByDadosCPF(cpf);
if (byDados) {
  console.log("[VERSA] fallback DadosUsuarioPorCPF funcionou");
  return byDados;
}

return null;

async function versaGetDadosUsuarioPorCodigo(codUsuario) {
  const id = Number(codUsuario);
  if (!Number.isFinite(id) || id <= 0) return { ok: false, data: null };

  const out = await versatilisFetch(`/api/Login/DadosUsuarioPorCodigo?CodUsuario=${encodeURIComponent(id)}`);
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

async function versaSolicitarSenhaPorCPF(cpfDigits, dtNascISO) {
  const cpf = String(cpfDigits || "").replace(/\D+/g, "");
  const dtBR = formatBRDateFromISO(dtNascISO);
  if (!cpf || !dtBR) return { ok: false };

  const path = `/api/Login/SolicitarSenha?login=${encodeURIComponent(cpf)}&dtNasc=${encodeURIComponent(dtBR)}`;
  const out = await versatilisFetch(path);
  return { ok: out.ok, out };
}

// =======================
// REGRA 30 DIAS (RETORNO)
// =======================
async function versaHadAppointmentLast30Days(codUsuario) {
  if (!codUsuario) return false;

  const out = await versatilisFetch(
    `/api/Agendamento/HistoricoAgendamento?codUsuario=${encodeURIComponent(codUsuario)}`
  );

  if (!out.ok || !Array.isArray(out.data)) {
    return false;
  }

  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  for (const ag of out.data) {
    if (!ag?.Data) continue;

    // Data vem no formato DD/MM/YYYY
    const parts = ag.Data.split("/");
    if (parts.length !== 3) continue;

    const [dd, mm, yyyy] = parts;
    const dateMs = new Date(`${yyyy}-${mm}-${dd}T00:00:00-03:00`).getTime();

    if (!Number.isFinite(dateMs)) continue;

    if (now - dateMs <= THIRTY_DAYS_MS) {
      return true; // teve consulta nos últimos 30 dias
    }
  }

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

async function versaUpsertPortalCompleto({ existsCodUsuario, form }) {
  // form: { nome, cpf, dtNascISO, sexoOpt, celular, email, cep, endereco, numero, complemento, bairro, cidade, uf, planoKey }
  // planoKey: "PARTICULAR" ou "MEDSENIOR_SP"
  const planoKey = form.planoKey;
  const codPlano = resolveCodPlano(planoKey); // ajuste depois com seus ENV se necessário

  const tempPass = generateTempPassword(10);
  const senhaMD5 = md5Hex(tempPass);

 const dtNascBR = formatBRDateFromISO(form.dtNascISO); // DD/MM/AAAA

// payload base (sem Senha por padrão)
const payload = {
  Nome: form.nome,
  CPF: form.cpf,
  Email: form.email,
  DtNasc: dtNascBR, // ✅ Versatilis geralmente espera BR aqui
  Celular: form.celular,
  Telefone: "",
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

// ✅ Para ALTERAR, inclua CodUsuario no body (muito comum ser obrigatório)
if (existsCodUsuario) {
  payload.CodUsuario = Number(existsCodUsuario);
}

  let out;
  if (existsCodUsuario) {
  out = await versatilisFetch("/api/Login/AlterarUsuario", { method: "PUT", jsonBody: payload });

   console.log("[PORTAL UPSERT] alterar", {
  ok: out.ok,
  status: out.status,
  rid: out.rid,
  data: out.data,
});
    
    if (!out.ok) return { ok: false, stage: "alterar", out };
    return { ok: true, codUsuario: existsCodUsuario };
  } else {
    out = await versatilisFetch("/api/Login/CadastrarUsuario", { method: "POST", jsonBody: payload });

    console.log("[PORTAL UPSERT] cadastrar", {
  ok: out.ok,
  status: out.status,
  rid: out.rid,
  data: out.data,
});
    
    if (!out.ok) return { ok: false, stage: "cadastrar", out };
    const codUsuario = Number(out?.data?.CodUsuario ?? out?.data?.codUsuario);
    return { ok: true, codUsuario: Number.isFinite(codUsuario) ? codUsuario : null };
  }
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

console.log("ENV CHECK:", {
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
  console.log("[REDIS GET] key=", key);

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
      console.log("[REDIS] sessão corrompida, limpando key=", key, "raw=", raw);
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

  console.log("[REDIS SET] key=", key, "len=", val.length);

  // Upstash: options object
  await redis.set(key, val, { ex: SESSION_TTL_SECONDS });
  return true;
}

async function deleteSession(phone) {
  const key = sessionKey(phone);
  await redis.del(key);
}

async function ensureSession(phone) {
  // estado mínimo permitido em memória transitória
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

async function touchUser(phone, phoneNumberIdFallback) {
  const s = await ensureSession(phone);
  s.lastUserTs = Date.now();
  if (phoneNumberIdFallback) s.lastPhoneNumberIdFallback = phoneNumberIdFallback;
  await saveSession(phone, s);
  return s;
}

async function setState(phone, state) {
  const s = await ensureSession(phone);
  s.state = state;
  await saveSession(phone, s);
  return s;
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
// TEXTOS
// =======================
const MSG = {
 
  ASK_CPF_PORTAL: `Para prosseguir com o agendamento, preciso confirmar seu cadastro.\n\nEnvie seu CPF (somente números).`,
CPF_INVALIDO: `⚠️ CPF inválido. Envie 11 dígitos (somente números).`,
PORTAL_NEED_DATA: (faltas) => `Para prosseguir, preciso completar seu cadastro do Portal do Paciente.\n\nFaltam:\n${faltas}\n\nVamos continuar.`,
PORTAL_NEED_DATA_EXISTING: (faltas) =>
  `Encontrei seu cadastro ✅, mas precisamos completar algumas informações do Portal do Paciente.\n\nFaltam:\n${faltas}\n\nVamos continuar.`,
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
1) Acesse o link de agendamento e escolha o melhor horário disponível
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
// HELPERS
// =======================

// ✅ NÃO usar Map. Tudo no Redis.
async function setBookingPlan(phone, planoKey) {
  const s = await ensureSession(phone);
  s.booking = { ...(s.booking || {}), planoKey };
  await saveSession(phone, s);
  return s;
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
// REGRAS DE TEMPO (segurança)
// =======================
const MIN_LEAD_HOURS = 6;              // mínimo de 6h
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
// BUSCAR HORÁRIOS DO DIA (Versatilis) + filtro 6h
// =======================
async function fetchSlotsDoDia({ codColaborador, codUsuario, isoDate }) {
  const path =
    `/api/Agenda/Datas?CodColaborador=${encodeURIComponent(codColaborador)}` +
    `&CodUsuario=${encodeURIComponent(codUsuario)}` +
    `&DataInicial=${encodeURIComponent(isoDate)}` +
    `&DataFinal=${encodeURIComponent(isoDate)}`;

  const out = await versatilisFetch(path);

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
    // ✅ filtro 6h aqui
    .filter((x) => isSlotAllowed(isoDate, x.hhmm));

  return { ok: true, slots };
}

// =======================
// BUSCAR PRÓXIMAS 3 DATAS DISPONÍVEIS (com slots após filtro 6h)
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
    return;
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

   await setState(phone, "ASK_DATE_PICK");
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
      body: "⚠️ Não há horários disponíveis (considerando o mínimo de 6h).",
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
    console.log("ERRO: token ausente (WHATSAPP_TOKEN/ACCESS_TOKEN/...).");
    return null;
  }

  if (!phoneNumberId) {
    console.log("ERRO: phone_number_id ausente (env ou webhook).");
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
    console.log("ERRO ao enviar texto:", resp.status, txt);
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
    console.log("ERRO ao enviar botões:", resp.status, txt);
    return false;
  }

  return true;
}

// =======================
// ENVIO + ESTADO
// =======================
async function sendAndSetState(phone, body, state, phoneNumberIdFallback) {
  await sendText({
    to: phone,
    body,
    phoneNumberIdFallback,
  });

  if (state) {
    await setState(phone, state);

    const back = await getState(phone);
    console.log("[STATE] set=", state, "readback=", back || "(none)");
  }
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
async function handleInbound(phone, inboundText, phoneNumberIdFallback) {
  // marca atividade do usuário (isso é o que conta como "silêncio")
  await touchUser(phone, phoneNumberIdFallback);

  const raw = normalizeSpaces(inboundText);
  const upper = raw.toUpperCase();
  const digits = onlyDigits(raw);

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
      console.log("[FLOW RESET] triggered", { phone: String(phone).slice(0, 4) + "****" });

      await clearSession(phone);
      await sendAndSetState(phone, MSG.MENU, "MAIN", phoneNumberIdFallback);
      return;
    }
  }
}

  const ctx = (await getState(phone)) || "MAIN";

// =======================
// AGENDAMENTO (datas + slots + confirmação)
// =======================

// 1) Usuário escolhe uma DATA (botão D_YYYY-MM-DD)
if (upper.startsWith("D_")) {
  const isoDate = raw.slice(2).trim(); // YYYY-MM-DD
  const s = await getSession(phone);

  const codColaborador = s.booking?.codColaborador ?? 3;
  const codUsuario = s.booking?.codUsuario;

  if (!codUsuario) {
    await sendText({
      to: phone,
      body: "⚠️ Sessão inválida. Digite 1 para iniciar novamente.",
      phoneNumberIdFallback,
    });
    await setState(phone, "MAIN");
    return;
  }

  s.booking = { ...(s.booking || {}), codColaborador, codUsuario, isoDate, pageIndex: 0 };

  const out = await fetchSlotsDoDia({ codColaborador, codUsuario, isoDate });
  s.booking.slots = out.ok ? out.slots : [];

  await setSession(phone, s);

  await setState(phone, "SLOTS");
  await showSlotsPage({ phone, phoneNumberIdFallback, slots: s.booking.slots, page: 0 });
  return;
}

// 2) Estado ASK_DATE_PICK: aguardando escolher data (apenas botões)
if (ctx === "ASK_DATE_PICK") {
  // Se o usuário digitou algo aleatório, reapresenta datas
  const s = await ensureSession(phone);
  const codColaborador = s?.booking?.codColaborador ?? 3;
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

  await showNextDates({ phone, phoneNumberIdFallback, codColaborador, codUsuario });
  return;
}

// 3) Estado SLOTS: paginação / trocar data / escolher horário
if (ctx === "SLOTS") {
  // Ver mais (PAGE_n)
  if (upper.startsWith("PAGE_")) {
    const n = Number(raw.split("_")[1]);
    const s = await ensureSession(phone);
    const slots = s?.booking?.slots || [];

    const page = Number.isFinite(n) && n >= 0 ? n : 0;
    if (s?.booking) s.booking.pageIndex = page;
    await saveSession(phone, s);

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
    if (s?.booking) {
      s.booking.isoDate = null;
      s.booking.slots = [];
      s.booking.pageIndex = 0;
      await saveSession(phone, s);
    }

    const codColaborador = s?.booking?.codColaborador ?? 3;
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
    await showNextDates({ phone, phoneNumberIdFallback, codColaborador, codUsuario });
    return;
  }

  // Clique em horário (H_XXXX) -> vai para confirmação
  if (upper.startsWith("H_")) {
    const codHorario = Number(raw.split("_")[1]);
    if (!codHorario || Number.isNaN(codHorario)) {
      await sendText({ to: phone, body: "⚠️ Horário inválido.", phoneNumberIdFallback });
      return;
    }

    const s = (await ensureSession(phone)) || { state: "MAIN", lastUserTs: Date.now(), lastPhoneNumberIdFallback: "" };
    s.pending = { codHorario };
    await saveSession(phone, s);

     await setState(phone, "WAIT_CONFIRM");

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
    if (s) delete s.pending;
    await saveSession(phone, s);

     await setState(phone, "SLOTS");

    // ✅ AQUI estava o seu problema clássico: chamada errada de showSlotsPage (dava erro e "não fazia nada")
    const slots = s?.booking?.slots || [];
    await showSlotsPage({ phone, phoneNumberIdFallback, slots, page: 0 });
    return;
  }

  if (upper === "CONFIRMAR") {
    const s = await ensureSession(phone);
    const codHorario = Number(s?.pending?.codHorario);

const planoSelecionado = resolveCodPlano(s?.booking?.planoKey || PLAN_KEYS.PARTICULAR);

const sConfirm = await ensureSession(phone);

const payload = {
  CodUnidade: 2,
  CodEspecialidade: 1003,
  CodPlano: planoSelecionado,
  CodHorario: codHorario,
  CodUsuario: sConfirm?.booking?.codUsuario,
  CodColaborador: 3, // fixo (é você)
  BitTelemedicina: false,
  Confirmada: true,
};

// Segurança: garante que existe paciente
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
      if (s) delete s.pending;
      await saveSession(phone, s);
       await setState(phone, "SLOTS");

      await sendText({ to: phone, body: "⚠️ Não encontrei o horário selecionado. Escolha novamente.", phoneNumberIdFallback });

      const slots = s?.booking?.slots || [];
      await showSlotsPage({ phone, phoneNumberIdFallback, slots, page: 0 });
      return;
    }

    // ✅ Segurança extra: mesmo que tenha passado antes, revalida “6h” na hora de confirmar
    const isoDate = s?.booking?.isoDate;
    const chosen = (s?.booking?.slots || []).find((x) => Number(x.codHorario) === codHorario);
    if (!isoDate || !chosen?.hhmm || !isSlotAllowed(isoDate, chosen.hhmm)) {
      if (s) delete s.pending;
      await saveSession(phone, s);
       await setState(phone, "SLOTS");

      await sendText({ to: phone, body: "⚠️ Este horário não pode mais ser agendado (mínimo de 6h). Escolha outro.", phoneNumberIdFallback });

      // refaz slots do dia (pra evitar lista desatualizada)
      const codColaborador = s?.booking?.codColaborador ?? 3;
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
      if (s?.booking) s.booking.slots = out.ok ? out.slots : [];
      await saveSession(phone, s);

      await showSlotsPage({ phone, phoneNumberIdFallback, slots: s?.booking?.slots || [], page: 0 });
      return;
    }

    const out = await versatilisFetch("/api/Agenda/ConfirmarAgendamento", {
      method: "POST",
      jsonBody: payload,
    });

    if (s) delete s.pending;
    await saveSession(phone, s);

    if (!out.ok) {
       await setState(phone, "SLOTS");
      await sendText({ to: phone, body: "⚠️ Não consegui confirmar agora. Tente outro horário ou digite AJUDA.", phoneNumberIdFallback });

      const slots = s?.booking?.slots || [];
      await showSlotsPage({ phone, phoneNumberIdFallback, slots, page: 0 });
      return;
    }

    const msgOk = out?.data?.Message || out?.data?.message || "Agendamento confirmado com sucesso!";

const ORIENTACOES = `Para que sua experiência seja ainda mais tranquila, recomendamos que chegue com 15 minutos de antecedência.

Nossa sala de espera foi pensada com carinho para seu conforto: ambiente acolhedor, água disponível, Wi-Fi gratuito e honest market com opções variadas.

Há estacionamento com valet no prédio.

Leve um documento oficial com foto para realizar seu cadastro na recepção do edifício e dirija-se ao 6º andar. Ao chegar, identifique-se no totem de atendimento.

Será um prazer recebê-lo(a). Até breve!`;

 await setState(phone, "MAIN");
await sendText({
  to: phone,
  body: `✅ ${msgOk}\n\n${ORIENTACOES}`,
  phoneNumberIdFallback,
});
return;
  }

  // Se mandou qualquer coisa diferente
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

  // padrão: volta ao menu
  await sendAndSetState(phone, MSG.MENU, "MAIN", phoneNumberIdFallback);
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

async function finishWizardAndGoToDates({ phone, phoneNumberIdFallback, codUsuario, planoKeyFromWizard }) {
  const s2 = await ensureSession(phone);

  const isRetorno = await versaHadAppointmentLast30Days(codUsuario);

  s2.booking = s2.booking || {};
  s2.booking.codUsuario = codUsuario;
  s2.booking.codColaborador = 3;
  s2.booking.isRetorno = isRetorno;

  // garante plano do wizard
  if (planoKeyFromWizard) s2.booking.planoKey = planoKeyFromWizard;

  await saveSession(phone, s2);

  await sendText({ to: phone, body: MSG.PORTAL_OK_RESET, phoneNumberIdFallback });

  await showNextDates({
    phone,
    phoneNumberIdFallback,
    codColaborador: s2.booking.codColaborador,
    codUsuario,
  });

  // showNextDates já seta ASK_DATE_PICK
}

// ---- roteamento do wizard por estado ----
if (String(ctx || "").startsWith("WZ_")) {

  // garante estrutura mínima
  const s = await ensureSession(phone);
  if (!s.portal) {
    s.portal = { codUsuario: null, exists: false, profile: null, form: {} };
  }
  if (!s.portal.form) s.portal.form = {};

  // =======================
  // WZ_CPF
  // =======================
  if (ctx === "WZ_CPF") {
    const cpf = onlyCpfDigits(raw);

    if (!cpf) {
      await sendText({ to: phone, body: MSG.CPF_INVALIDO, phoneNumberIdFallback });
      return;
    }

    s.portal.form.cpf = cpf;

    // tenta achar cadastro
    const codUsuario = await versaFindCodUsuarioByCPF(cpf);

    if (codUsuario) {
      s.portal.exists = true;
      s.portal.codUsuario = codUsuario;

      const prof = await versaGetDadosUsuarioPorCodigo(codUsuario);
      s.portal.profile = prof.ok ? prof.data : null;

      if (prof.ok && prof.data) {
        const v = validatePortalCompleteness(prof.data);

        // se já está completo, pula wizard e vai direto pras datas
        if (v.ok) {
          await saveSession(phone, s);
          await finishWizardAndGoToDates({
            phone,
            phoneNumberIdFallback,
            codUsuario,
            planoKeyFromWizard: s.booking?.planoKey || null,
          });
          return;
        }

        // se está incompleto, avisa faltas e vai para o primeiro passo faltante
        await saveSession(phone, s);
        await sendText({
          to: phone,
          body: MSG.PORTAL_NEED_DATA_EXISTING(formatMissing(v.missing)),
          phoneNumberIdFallback,
        });

        const next = nextWizardStateFromMissing(v.missing);
        await setState(phone, next);

        // dispara a primeira pergunta
        if (next === "WZ_NOME") await sendText({ to: phone, body: MSG.ASK_NOME, phoneNumberIdFallback });
        else if (next === "WZ_DTNASC") await sendText({ to: phone, body: MSG.ASK_DTNASC, phoneNumberIdFallback });
        else if (next === "WZ_EMAIL") await sendText({ to: phone, body: MSG.ASK_EMAIL, phoneNumberIdFallback });
        else if (next === "WZ_CEP") await sendText({ to: phone, body: MSG.ASK_CEP, phoneNumberIdFallback });
        else if (next === "WZ_ENDERECO") await sendText({ to: phone, body: MSG.ASK_ENDERECO, phoneNumberIdFallback });
        else if (next === "WZ_NUMERO") await sendText({ to: phone, body: MSG.ASK_NUMERO, phoneNumberIdFallback });
        else if (next === "WZ_BAIRRO") await sendText({ to: phone, body: MSG.ASK_BAIRRO, phoneNumberIdFallback });
        else if (next === "WZ_CIDADE") await sendText({ to: phone, body: MSG.ASK_CIDADE, phoneNumberIdFallback });
        else if (next === "WZ_UF") await sendText({ to: phone, body: MSG.ASK_UF, phoneNumberIdFallback });

        return;
      }

      // se não conseguiu ler perfil, segue wizard completo por segurança
      await saveSession(phone, s);
      await sendAndSetState(phone, MSG.ASK_NOME, "WZ_NOME", phoneNumberIdFallback);
      return;
    }

    // paciente novo -> wizard completo
    s.portal.exists = false;
    s.portal.codUsuario = null;
    await saveSession(phone, s);

    await sendAndSetState(phone, MSG.ASK_NOME, "WZ_NOME", phoneNumberIdFallback);
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
    s.portal.form.nome = nome;
    await saveSession(phone, s);
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
    s.portal.form.dtNascISO = iso;
    await saveSession(phone, s);

    await sendButtons({
      to: phone,
      body: "Sexo (opcional):",
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
    if (upper === "SX_M") s.portal.form.sexoOpt = "M";
    else if (upper === "SX_F") s.portal.form.sexoOpt = "F";
    else s.portal.form.sexoOpt = "NI";

    await saveSession(phone, s);

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

    s.portal.form.planoKey = (upper === "PL_MED") ? "MEDSENIOR_SP" : "PARTICULAR";
    s.portal.form.celular = formatCellFromWA(phone);

    await saveSession(phone, s);
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
    s.portal.form.email = email;
    await saveSession(phone, s);
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
    s.portal.form.cep = cep;
    await saveSession(phone, s);
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
    s.portal.form.endereco = v;
    await saveSession(phone, s);
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
    s.portal.form.numero = v;
    await saveSession(phone, s);
    await sendAndSetState(phone, MSG.ASK_COMPLEMENTO, "WZ_COMPLEMENTO", phoneNumberIdFallback);
    return;
  }

  // =======================
  // WZ_COMPLEMENTO
  // =======================
  if (ctx === "WZ_COMPLEMENTO") {
    s.portal.form.complemento = cleanStr(raw);
    await saveSession(phone, s);
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
    s.portal.form.bairro = v;
    await saveSession(phone, s);
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
    s.portal.form.cidade = v;
    await saveSession(phone, s);
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
    s.portal.form.uf = uf;

    const existsCodUsuario = s.portal.exists ? s.portal.codUsuario : null;

    const up = await versaUpsertPortalCompleto({
      existsCodUsuario,
      form: s.portal.form,
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
      console.log("[PORTAL] solicitar senha", { ok: !!reset?.ok, status: reset?.out?.status });
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

    await saveSession(phone, s);

    await finishWizardAndGoToDates({
      phone,
      phoneNumberIdFallback,
      codUsuario: up.codUsuario,
      planoKeyFromWizard: s.portal.form.planoKey,
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
  const s = (await ensureSession(phone)) || { state: "MAIN", lastUserTs: Date.now(), lastPhoneNumberIdFallback: "" };
  s.booking = { codColaborador: 3, codUsuario: null, isoDate: null, slots: [], pageIndex: 0, isRetorno: false };
  s.portal = { step: "CPF", codUsuario: null, exists: false, profile: null, form: {} };
  await saveSession(phone, s);

  await sendAndSetState(phone, MSG.ASK_CPF_PORTAL, "WZ_CPF", phoneNumberIdFallback);
  return;
}

  if (digits === "0") return sendAndSetState(phone, MSG.MENU, "MAIN", phoneNumberIdFallback);
  return sendAndSetState(phone, MSG.PARTICULAR, "PARTICULAR", phoneNumberIdFallback);
}

  // -------------------
  // CONTEXTO: CONVENIOS
  // -------------------
  if (ctx === "CONVENIOS") {
    if (digits === "0") return sendAndSetState(phone, MSG.MENU, "MAIN", phoneNumberIdFallback);

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
    if (digits === "0") return sendAndSetState(phone, MSG.MENU, "MAIN", phoneNumberIdFallback);
    return sendAndSetState(phone, MSG.CONVENIOS, "CONVENIOS", phoneNumberIdFallback);
  }

  // -------------------
  // CONTEXTO: MEDSENIOR
  // -------------------
  if (ctx === "MEDSENIOR") {
    if (digits === "1") {
  const s = (await ensureSession(phone)) || { state: "MAIN", lastUserTs: Date.now(), lastPhoneNumberIdFallback: "" };
  s.booking = { codColaborador: 3, codUsuario: null, isoDate: null, slots: [], pageIndex: 0, isRetorno: false };
  s.portal = { step: "CPF", codUsuario: null, exists: false, profile: null, form: {} };
  await saveSession(phone, s);

  await sendAndSetState(phone, MSG.ASK_CPF_PORTAL, "WZ_CPF", phoneNumberIdFallback);
  return;
}
    if (digits === "0") return sendAndSetState(phone, MSG.MENU, "MAIN", phoneNumberIdFallback);
    return sendAndSetState(phone, MSG.MEDSENIOR, "MEDSENIOR", phoneNumberIdFallback);
  }

  // -------------------
  // CONTEXTO: POS
  // -------------------
  if (ctx === "POS") {
    if (digits === "1") return sendAndSetState(phone, MSG.POS_RECENTE, "POS_RECENTE", phoneNumberIdFallback);
    if (digits === "2") return sendAndSetState(phone, MSG.POS_TARDIO, "POS_TARDIO", phoneNumberIdFallback);
    if (digits === "0") return sendAndSetState(phone, MSG.MENU, "MAIN", phoneNumberIdFallback);
    return sendAndSetState(phone, MSG.POS_MENU, "POS", phoneNumberIdFallback);
  }

  // -------------------
  // CONTEXTO: POS_RECENTE
  // -------------------
  if (ctx === "POS_RECENTE") {
    if (digits === "0") return sendAndSetState(phone, MSG.MENU, "MAIN", phoneNumberIdFallback);
    return sendAndSetState(phone, MSG.POS_RECENTE, "POS_RECENTE", phoneNumberIdFallback);
  }

  // -------------------
  // CONTEXTO: POS_TARDIO
  // -------------------
  if (ctx === "POS_TARDIO") {
    if (digits === "1") return sendAndSetState(phone, MSG.PARTICULAR, "PARTICULAR", phoneNumberIdFallback);
    if (digits === "2") return sendAndSetState(phone, MSG.CONVENIOS, "CONVENIOS", phoneNumberIdFallback);
    if (digits === "0") return sendAndSetState(phone, MSG.MENU, "MAIN", phoneNumberIdFallback);
    return sendAndSetState(phone, MSG.POS_TARDIO, "POS_TARDIO", phoneNumberIdFallback);
  }

  // -------------------
  // CONTEXTO: ATENDENTE
  // -------------------
  if (ctx === "ATENDENTE") {
    if (digits === "0") return sendAndSetState(phone, MSG.MENU, "MAIN", phoneNumberIdFallback);
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
    
    const text = (
  msg.text?.body ||
  msg.interactive?.button_reply?.id ||
  ""
).trim();

    const phoneNumberIdFallback = value?.metadata?.phone_number_id || "";

    function maskPhone(p) {
  if (!p) return "***";
  return p.length > 6
    ? p.slice(0, 4) + "****" + p.slice(-2)
    : "***";
}

console.log("MSG FROM:", maskPhone(from));
console.log("MSG RECEIVED: [hidden]");
console.log("STATE:", (await getState(from)) || "(none)");

    await handleInbound(from, text, phoneNumberIdFallback);
  } catch (err) {
    console.log("ERRO no POST /webhook:", err);
  }
});

// =======================
// PROTEÇÃO GLOBAL PARA /debug
// =======================
function requireDebugKey(req, res, next) {
  const DEBUG_KEY = process.env.DEBUG_KEY;
  const provided = req.query.k || req.headers["x-debug-key"];

  if (!DEBUG_KEY || provided !== DEBUG_KEY) {
    return res.status(403).json({ ok: false, error: "forbidden (missing/invalid debug key)" });
  }

  next();
}

// Aplica proteção em TODAS as rotas que começam com /debug
app.use("/debug", requireDebugKey);

app.get("/debug/versatilis/especialidades", async (req, res) => {
  try {
    const out = await versatilisFetch("/api/Especialidade/Especialidades");
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
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
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
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
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
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

if (!payload.CodUsuario || Number.isNaN(payload.CodUsuario)) {
  return res.status(400).json({ ok: false, error: "CodUsuario é obrigatório (number)" });
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
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
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
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
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
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/debug/session/get", async (req, res) => {
  const phone = String(req.query.phone || "");
  const key = sessionKey(phone);
  const raw = await redis.get(key);
  return res.json({ ok: true, phone, key, raw });
});

app.get("/debug/session/del", async (req, res) => {
  const phone = String(req.query.phone || "");
  const key = sessionKey(phone);
  await redis.del(key);
  return res.json({ ok: true, phone, key, deleted: true });
});

app.post("/debug/session/clear", async (req, res) => {
  try {
    const phone = String(req.body?.phone || "").replace(/\D+/g, "");
    if (!phone) return res.status(400).json({ ok: false, error: "phone obrigatório" });

    const key = sessionKey(phone);
    await redis.del(key);

    return res.json({ ok: true, deleted: key });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/debug/versatilis/codusuario", async (req, res) => {
  try {
    const cpf = String(req.query.cpf || "").replace(/\D+/g, "");
    if (cpf.length !== 11) return res.status(400).json({ ok: false, error: "cpf inválido (11 dígitos)" });

    const codUsuario = await versaFindCodUsuarioByCPF(cpf);
    return res.json({ ok: true, cpf, codUsuario });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// =======================
app.listen(port, () => console.log(`Server running on port ${port}`));
