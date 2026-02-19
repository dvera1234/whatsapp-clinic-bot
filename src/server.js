import express from "express";

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

import crypto from "crypto";

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

  const r = await fetch(`${VERSA_BASE}${path}`, {
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

  // log mínimo (sem dados sensíveis)
  console.log("[VERSATILIS]", { method, path, status: r.status });

  return { ok: r.ok, status: r.status, data };
}

async function versaFindCodUsuarioByCPF(cpfDigits) {
  const cpf = String(cpfDigits || "").replace(/\D+/g, "");
  if (cpf.length !== 11) return null;

  const out = await versatilisFetch(`/api/Login/CodUsuario?CPF=${encodeURIComponent(cpf)}`);
  if (!out.ok) return null;

  const n = Number(out?.data?.CodUsuario ?? out?.data?.codUsuario);
  return Number.isFinite(n) && n > 0 ? n : null;
}

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
  const codPlano = (planoKey === "MEDSENIOR_SP") ? 3011 : 2; // ajuste depois com seus ENV se necessário

  const tempPass = generateTempPassword(10);
  const senhaMD5 = md5Hex(tempPass);

  const payload = {
    Nome: form.nome,
    CPF: form.cpf,
    Email: form.email,
    Senha: senhaMD5,
    DtNasc: form.dtNascISO,
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

  let out;
  if (existsCodUsuario) {
    out = await versatilisFetch("/api/Login/AlterarUsuario", { method: "PUT", jsonBody: payload });
    if (!out.ok) return { ok: false, stage: "alterar", out };
    return { ok: true, codUsuario: existsCodUsuario };
  } else {
    out = await versatilisFetch("/api/Login/CadastrarUsuario", { method: "POST", jsonBody: payload });
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
});

// =======================
// CONFIG
// =======================
const INACTIVITY_MS = 10 * 60 * 1000; // mantemos por enquanto (será revisado)
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 900); // 15 min (900s)

// Sessão 100% Redis (uma chave por telefone)
function sessionKey(phone) {
  return `sess:${String(phone || "").replace(/\D+/g, "")}`;
}

async function loadSession(phone) {
  const key = sessionKey(phone);
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // se corromper, falha segura: “sem sessão”
    return null;
  }
}

async function saveSession(phone, sessionObj) {
   const key = sessionKey(phone); 
   await redis.set(key, JSON.stringify(sessionObj), "EX", SESSION_TTL_SECONDS);
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
ASK_NOME: `Informe seu nome completo:`,
ASK_DTNASC: `Informe sua data de nascimento (DD/MM/AAAA):`,
ASK_SEXO: `Selecione seu sexo (opcional):`,
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

  setState(phone, "ASK_DATE_PICK");
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

    // ✅ diagnóstico: confirma que gravou e que está lendo do Redis
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

  const ctx = (await getState(phone)) || "MAIN";

// =======================
// AGENDAMENTO (datas + slots + confirmação)
// =======================

// 1) Usuário escolhe uma DATA (botão D_YYYY-MM-DD)
if (upper.startsWith("D_")) {
  const isoDate = raw.slice(2).trim(); // YYYY-MM-DD
  const s = sessions.get(phone) || { state: "MAIN", lastUserTs: Date.now(), lastPhoneNumberIdFallback: "" };

  const codColaborador = s.booking?.codColaborador ?? 3;
  const codUsuario = s?.booking?.codUsuario;
if (!codUsuario) {
  await sendText({
    to: phone,
    body: "⚠️ Sessão inválida. Digite 1 para iniciar novamente.",
    phoneNumberIdFallback,
  });
  setState(phone, "MAIN");
  return;
}

  s.booking = { ...(s.booking || {}), codColaborador, codUsuario, isoDate, pageIndex: 0 };

  const out = await fetchSlotsDoDia({ codColaborador, codUsuario, isoDate });
  s.booking.slots = out.ok ? out.slots : [];
  sessions.set(phone, s);

  setState(phone, "SLOTS");
  await showSlotsPage({
    phone,
    phoneNumberIdFallback,
    slots: s.booking.slots,
    page: 0,
  });
  return;
}

// 2) Estado ASK_DATE_PICK: aguardando escolher data (apenas botões)
if (ctx === "ASK_DATE_PICK") {
  // Se o usuário digitou algo aleatório, reapresenta datas
  const s = sessions.get(phone);
  const codColaborador = s?.booking?.codColaborador ?? 3;
  const codUsuario = s?.booking?.codUsuario;
if (!codUsuario) {
  await sendText({
    to: phone,
    body: "⚠️ Sessão inválida. Digite 1 para iniciar novamente.",
    phoneNumberIdFallback,
  });
  setState(phone, "MAIN");
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
    const s = sessions.get(phone);
    const slots = s?.booking?.slots || [];

    const page = Number.isFinite(n) && n >= 0 ? n : 0;
    if (s?.booking) s.booking.pageIndex = page;
    sessions.set(phone, s);

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
    const s = sessions.get(phone);
    if (s?.booking) {
      s.booking.isoDate = null;
      s.booking.slots = [];
      s.booking.pageIndex = 0;
      sessions.set(phone, s);
    }

    const codColaborador = s?.booking?.codColaborador ?? 3;
    const codUsuario = s?.booking?.codUsuario;
if (!codUsuario) {
  await sendText({
    to: phone,
    body: "⚠️ Sessão inválida. Digite 1 para iniciar novamente.",
    phoneNumberIdFallback,
  });
  setState(phone, "MAIN");
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

    const s = sessions.get(phone) || { state: "MAIN", lastUserTs: Date.now(), lastPhoneNumberIdFallback: "" };
    s.pending = { codHorario };
    sessions.set(phone, s);

    setState(phone, "WAIT_CONFIRM");

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
    const s = sessions.get(phone);
    const slots = s?.booking?.slots || [];
    const page = Number(s?.booking?.pageIndex ?? 0) || 0;

    await showSlotsPage({ phone, phoneNumberIdFallback, slots, page });
    return;
  }
}

// 4) Estado WAIT_CONFIRM: confirmar / escolher outro
if (ctx === "WAIT_CONFIRM") {
  if (upper === "ESCOLHER_OUTRO") {
    const s = sessions.get(phone);
    if (s) delete s.pending;
    sessions.set(phone, s);

    setState(phone, "SLOTS");

    // ✅ AQUI estava o seu problema clássico: chamada errada de showSlotsPage (dava erro e "não fazia nada")
    const slots = s?.booking?.slots || [];
    await showSlotsPage({ phone, phoneNumberIdFallback, slots, page: 0 });
    return;
  }

  if (upper === "CONFIRMAR") {
    const s = sessions.get(phone);
    const codHorario = Number(s?.pending?.codHorario);

const planoSelecionado = resolveCodPlano(s?.booking?.planoKey);

const sConfirm = sessions.get(phone);

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
  setState(phone, "MAIN");
  return;
}

    if (!codHorario || Number.isNaN(codHorario)) {
      if (s) delete s.pending;
      sessions.set(phone, s);
      setState(phone, "SLOTS");

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
      sessions.set(phone, s);
      setState(phone, "SLOTS");

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
  setState(phone, "MAIN");
  return;
}
      const out = await fetchSlotsDoDia({ codColaborador, codUsuario, isoDate });
      if (s?.booking) s.booking.slots = out.ok ? out.slots : [];
      sessions.set(phone, s);

      await showSlotsPage({ phone, phoneNumberIdFallback, slots: s?.booking?.slots || [], page: 0 });
      return;
    }

    const out = await versatilisFetch("/api/Agenda/ConfirmarAgendamento", {
      method: "POST",
      jsonBody: payload,
    });

    if (s) delete s.pending;
    sessions.set(phone, s);

    if (!out.ok) {
      setState(phone, "SLOTS");
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

setState(phone, "MAIN");
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
  if (!digits) {
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

if (ctx === "WZ_CPF") {
  const cpf = onlyCpfDigits(raw);
  if (!cpf) {
    await sendText({ to: phone, body: MSG.CPF_INVALIDO, phoneNumberIdFallback });
    return;
  }

  const s = sessions.get(phone) || {};
  s.portal = s.portal || { form: {} };
  s.portal.form.cpf = cpf;
  sessions.set(phone, s);

  const codUsuario = await versaFindCodUsuarioByCPF(cpf);
  s.portal.codUsuario = codUsuario;
  s.portal.exists = !!codUsuario;

  if (codUsuario) {
    const prof = await versaGetDadosUsuarioPorCodigo(codUsuario);
    s.portal.profile = prof.ok ? prof.data : null;

    // valida completude
    const v = prof.ok ? validatePortalCompleteness(prof.data) : { ok: false, missing: ["dados do cadastro"] };

    sessions.set(phone, s);

    if (v.ok) {
      // cadastro ok -> segue (mas ainda vamos coletar convênio permitido no bot)
      await sendButtons({
        to: phone,
        body: "Cadastro confirmado ✅\n\nSelecione o convênio para este agendamento:",
        buttons: [
          { id: "PL_PART", title: "Particular" },
          { id: "PL_MED", title: "MedSênior SP" },
        ],
        phoneNumberIdFallback,
      });
      setState(phone, "WZ_PLANO");
      return;
    }

    // falta algo -> wizard completo (não deixa passar)
    await sendText({
      to: phone,
      body: MSG.PORTAL_NEED_DATA(formatMissing(v.missing)),
      phoneNumberIdFallback,
    });

    // pré-preenche com o que já existe
    const p = prof.data || {};
    s.portal.form.nome = cleanStr(p.Nome) || "";
    s.portal.form.email = cleanStr(p.Email) || "";
    // DtNasc pode vir com hora; pega só a parte da data
    const dt = cleanStr(p.DtNasc);
    s.portal.form.dtNascISO = dt ? dt.slice(0, 10) : "";
    s.portal.form.celular = cleanStr(p.Celular).replace(/\D+/g, "") || formatCellFromWA(phone);

    s.portal.form.cep = cleanStr(p.CEP).replace(/\D+/g, "") || "";
    s.portal.form.endereco = cleanStr(p.Endereco) || "";
    s.portal.form.numero = cleanStr(p.Numero) || "";
    s.portal.form.complemento = cleanStr(p.Complemento) || "";
    s.portal.form.bairro = cleanStr(p.Bairro) || "";
    s.portal.form.cidade = cleanStr(p.Cidade) || "";

    sessions.set(phone, s);

    // Começa pedindo nome (se já tiver, você pode pular manualmente depois)
    await sendAndSetState(phone, MSG.ASK_NOME, "WZ_NOME", phoneNumberIdFallback);
    return;
  }

  // Não existe -> wizard completo (cadastrar)
  sessions.set(phone, s);
  await sendAndSetState(phone, MSG.ASK_NOME, "WZ_NOME", phoneNumberIdFallback);
  return;
}

if (ctx === "WZ_NOME") {
  const s = sessions.get(phone);
  const nome = cleanStr(raw);
  if (nome.length < 5) {
    await sendText({ to: phone, body: "⚠️ Envie seu nome completo.", phoneNumberIdFallback });
    return;
  }
  s.portal.form.nome = nome;
  sessions.set(phone, s);
  await sendAndSetState(phone, MSG.ASK_DTNASC, "WZ_DTNASC", phoneNumberIdFallback);
  return;
}

if (ctx === "WZ_DTNASC") {
  const s = sessions.get(phone);
  const iso = parseBRDateToISO(raw);
  if (!iso) {
    await sendText({ to: phone, body: "⚠️ Data inválida. Use DD/MM/AAAA.", phoneNumberIdFallback });
    return;
  }
  s.portal.form.dtNascISO = iso;
  sessions.set(phone, s);

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
  setState(phone, "WZ_SEXO");
  return;
}

if (ctx === "WZ_SEXO") {
  const s = sessions.get(phone);
  if (upper === "SX_M") s.portal.form.sexoOpt = "M";
  else if (upper === "SX_F") s.portal.form.sexoOpt = "F";
  else s.portal.form.sexoOpt = "NI"; // não envia

  sessions.set(phone, s);

  await sendButtons({
    to: phone,
    body: "Selecione o convênio para este agendamento:",
    buttons: [
      { id: "PL_PART", title: "Particular" },
      { id: "PL_MED", title: "MedSênior SP" },
    ],
    phoneNumberIdFallback,
  });
  setState(phone, "WZ_PLANO");
  return;
}

if (ctx === "WZ_PLANO") {
  const s = sessions.get(phone);
  if (upper !== "PL_PART" && upper !== "PL_MED") {
    await sendText({ to: phone, body: "Use os botões para selecionar o convênio.", phoneNumberIdFallback });
    return;
  }
  s.portal.form.planoKey = (upper === "PL_MED") ? "MEDSENIOR_SP" : "PARTICULAR";

  // Celular: usa o do WA (confirmável depois se quiser)
  s.portal.form.celular = formatCellFromWA(phone);

  sessions.set(phone, s);
  await sendAndSetState(phone, MSG.ASK_EMAIL, "WZ_EMAIL", phoneNumberIdFallback);
  return;
}

if (ctx === "WZ_EMAIL") {
  const s = sessions.get(phone);
  const email = cleanStr(raw);
  if (!isValidEmail(email)) {
    await sendText({ to: phone, body: "⚠️ E-mail inválido.", phoneNumberIdFallback });
    return;
  }
  s.portal.form.email = email;
  sessions.set(phone, s);
  await sendAndSetState(phone, MSG.ASK_CEP, "WZ_CEP", phoneNumberIdFallback);
  return;
}

if (ctx === "WZ_CEP") {
  const s = sessions.get(phone);
  const cep = normalizeCEP(raw);
  if (cep.length !== 8) {
    await sendText({ to: phone, body: "⚠️ CEP inválido. Envie 8 dígitos.", phoneNumberIdFallback });
    return;
  }
  s.portal.form.cep = cep;
  sessions.set(phone, s);
  await sendAndSetState(phone, MSG.ASK_ENDERECO, "WZ_ENDERECO", phoneNumberIdFallback);
  return;
}

if (ctx === "WZ_ENDERECO") {
  const s = sessions.get(phone);
  const v = cleanStr(raw);
  if (v.length < 3) {
    await sendText({ to: phone, body: "⚠️ Endereço inválido.", phoneNumberIdFallback });
    return;
  }
  s.portal.form.endereco = v;
  sessions.set(phone, s);
  await sendAndSetState(phone, MSG.ASK_NUMERO, "WZ_NUMERO", phoneNumberIdFallback);
  return;
}

if (ctx === "WZ_NUMERO") {
  const s = sessions.get(phone);
  const v = cleanStr(raw);
  if (!v) {
    await sendText({ to: phone, body: "⚠️ Informe o número.", phoneNumberIdFallback });
    return;
  }
  s.portal.form.numero = v;
  sessions.set(phone, s);
  await sendAndSetState(phone, MSG.ASK_COMPLEMENTO, "WZ_COMPLEMENTO", phoneNumberIdFallback);
  return;
}

if (ctx === "WZ_COMPLEMENTO") {
  const s = sessions.get(phone);
  const v = cleanStr(raw);
  s.portal.form.complemento = v; // "0" permitido
  sessions.set(phone, s);
  await sendAndSetState(phone, MSG.ASK_BAIRRO, "WZ_BAIRRO", phoneNumberIdFallback);
  return;
}

if (ctx === "WZ_BAIRRO") {
  const s = sessions.get(phone);
  const v = cleanStr(raw);
  if (!v) {
    await sendText({ to: phone, body: "⚠️ Informe o bairro.", phoneNumberIdFallback });
    return;
  }
  s.portal.form.bairro = v;
  sessions.set(phone, s);
  await sendAndSetState(phone, MSG.ASK_CIDADE, "WZ_CIDADE", phoneNumberIdFallback);
  return;
}

if (ctx === "WZ_CIDADE") {
  const s = sessions.get(phone);
  const v = cleanStr(raw);
  if (!v) {
    await sendText({ to: phone, body: "⚠️ Informe a cidade.", phoneNumberIdFallback });
    return;
  }
  s.portal.form.cidade = v;
  sessions.set(phone, s);
  await sendAndSetState(phone, MSG.ASK_UF, "WZ_UF", phoneNumberIdFallback);
  return;
}

if (ctx === "WZ_UF") {
  const s = sessions.get(phone);
  const uf = cleanStr(raw).toUpperCase();
  if (!/^[A-Z]{2}$/.test(uf)) {
    await sendText({ to: phone, body: "⚠️ UF inválida. Ex.: SP", phoneNumberIdFallback });
    return;
  }
  s.portal.form.uf = uf;

  // UPSERT + reset
  const existsCodUsuario = s.portal.exists ? s.portal.codUsuario : null;

  const up = await versaUpsertPortalCompleto({
    existsCodUsuario,
    form: s.portal.form,
  });

  if (!up.ok || !up.codUsuario) {
    await sendText({ to: phone, body: "⚠️ Não consegui atualizar seu cadastro agora. Digite AJUDA para falar com nossa equipe.", phoneNumberIdFallback });
    setState(phone, "MAIN");
    return;
  }

 // Dispara reset SOMENTE se for paciente novo
if (!existsCodUsuario) {
  await versaSolicitarSenhaPorCPF(
    s.portal.form.cpf,
    s.portal.form.dtNascISO
  );
}

  // Revalida 100% no Versatilis
  const prof2 = await versaGetDadosUsuarioPorCodigo(up.codUsuario);
  const v2 = prof2.ok ? validatePortalCompleteness(prof2.data) : { ok: false, missing: ["dados do cadastro"] };

  if (!v2.ok) {
    // Continua wizard — não deixa passar
    await sendText({ to: phone, body: MSG.PORTAL_NEED_DATA(formatMissing(v2.missing)), phoneNumberIdFallback });
    // reinicia do e-mail (é o mais comum faltar/formatar)
    setState(phone, "WZ_EMAIL");
    await sendText({ to: phone, body: MSG.ASK_EMAIL, phoneNumberIdFallback });
    return;
  }

  // Cadastro ok -> segue para regra retorno vs primeira e datas/slots
 const codUsuario = up.codUsuario;
const s2 = sessions.get(phone) || s;

// regra 30 dias
const isRetorno = await versaHadAppointmentLast30Days(codUsuario);

s2.booking = s2.booking || {};
s2.booking.codUsuario = codUsuario;
s2.booking.codColaborador = 3; // fixo
s2.booking.isRetorno = isRetorno;

// 🔹 GARANTE QUE O PLANO DO WIZARD VÁ PARA O BOOKING
s2.booking.planoKey = s.portal.form.planoKey;

sessions.set(phone, s2);

  await sendText({ to: phone, body: MSG.PORTAL_OK_RESET, phoneNumberIdFallback });

  await showNextDates({
    phone,
    phoneNumberIdFallback,
    codColaborador: s2.booking.codColaborador,
    codUsuario,
  });

  // muda estado para seleção de data (showNextDates já seta ASK_DATE_PICK)
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
  const s = sessions.get(phone) || { state: "MAIN", lastUserTs: Date.now(), lastPhoneNumberIdFallback: "" };
  s.booking = { codColaborador: 3, codUsuario: null, isoDate: null, slots: [], pageIndex: 0, isRetorno: false };
  s.portal = { step: "CPF", codUsuario: null, exists: false, profile: null, form: {} };
  sessions.set(phone, s);

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
  const s = sessions.get(phone) || { state: "MAIN", lastUserTs: Date.now(), lastPhoneNumberIdFallback: "" };
  s.booking = { codColaborador: 3, codUsuario: null, isoDate: null, slots: [], pageIndex: 0, isRetorno: false };
  s.portal = { step: "CPF", codUsuario: null, exists: false, profile: null, form: {} };
  sessions.set(phone, s);

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
    const redis = getRedisClient();

    const key = "health:redis";
    const value = `ok:${Date.now()}`;

    await redis.set(key, value, { ex: 30 }); // expira em 30s
    const read = await redis.get(key);

    return res.status(200).json({ ok: true, wrote: value, read });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// =======================
app.listen(port, () => console.log(`Server running on port ${port}`));
