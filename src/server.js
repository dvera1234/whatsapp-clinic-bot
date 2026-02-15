import express from "express";

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

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
    throw new Error(`Versatilis Token falhou status=${r.status} body=${JSON.stringify(json)}`);
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
const INACTIVITY_MS = 10 * 60 * 1000; // 10 min sem o usuário falar
const SWEEP_EVERY_MS = 30 * 1000; // varre a cada 30s

// phone -> { state, lastUserTs, lastPhoneNumberIdFallback }
const sessions = new Map();

function touchUser(phone, phoneNumberIdFallback) {
  const s = sessions.get(phone) || { state: null, lastUserTs: 0, lastPhoneNumberIdFallback: "" };
  s.lastUserTs = Date.now();
  if (phoneNumberIdFallback) s.lastPhoneNumberIdFallback = phoneNumberIdFallback;
  sessions.set(phone, s);
}

function setState(phone, state) {
  const s = sessions.get(phone) || { state: null, lastUserTs: Date.now(), lastPhoneNumberIdFallback: "" };
  s.state = state;
  sessions.set(phone, s);
}

function getState(phone) {
  const s = sessions.get(phone);
  return s?.state || null;
}

function clearSession(phone) {
  sessions.delete(phone);
}

// =======================
// CONTATO SUPORTE (link clicável)
// =======================
const SUPPORT_WA = "5519933005596";

// =======================
// TEXTOS
// =======================
const MSG = {
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

Ao chegar, realize o check-in no totem localizado
na recepção da unidade.

Formas de pagamento
• Pix
• Débito
• Cartão de crédito

Todos os pagamentos devem ser realizados no totem de atendimento,
no momento da chegada ao consultório, antes da consulta.

Agendamento
Escolha uma opção:
1) Acesse o link de agendamento e escolha o melhor horário disponível
0) Voltar ao menu inicial`,

  LINK_AGENDAMENTO: `👉 Link de agendamento:
bit.ly/drdavidvera

Após a confirmação, você receberá as orientações para o dia da consulta.

Se tiver qualquer dificuldade durante o agendamento,
envie uma mensagem com a palavra AJUDA.

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

  if (state) setState(phone, state);
}

// =======================
// AUTO-ENCERRAMENTO (10 min silêncio)
// - envia mensagem
// - limpa estado
// =======================
setInterval(async () => {
  const now = Date.now();

  for (const [phone, s] of sessions.entries()) {
    const idle = now - (s.lastUserTs || 0);
    if (idle < INACTIVITY_MS) continue;

    // Envia encerramento e limpa
    console.log(`AUTO-CLOSE: ${phone} idle=${Math.round(idle / 1000)}s state=${s.state || "(none)"}`);

    await sendText({
      to: phone,
      body: MSG.ENCERRAMENTO,
      phoneNumberIdFallback: s.lastPhoneNumberIdFallback || "",
    });

    clearSession(phone);
  }
}, SWEEP_EVERY_MS);

// =======================
// ROTEADOR COM ESTADO MÍNIMO
// =======================
async function handleInbound(phone, inboundText, phoneNumberIdFallback) {
  // marca atividade do usuário (isso é o que conta como "silêncio")
  touchUser(phone, phoneNumberIdFallback);

  const raw = normalizeSpaces(inboundText);
  const upper = raw.toUpperCase();
  const digits = onlyDigits(raw);

  const ctx = getState(phone) || "MAIN";

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

  // -------------------
  // CONTEXTO: MAIN
  // -------------------
  if (ctx === "MAIN") {
    if (digits === "1") return sendAndSetState(phone, MSG.PARTICULAR, "PARTICULAR", phoneNumberIdFallback);
    if (digits === "2") return sendAndSetState(phone, MSG.CONVENIOS, "CONVENIOS", phoneNumberIdFallback);
    if (digits === "3") return sendAndSetState(phone, MSG.POS_MENU, "POS", phoneNumberIdFallback);
    if (digits === "4") return sendAndSetState(phone, MSG.ATENDENTE, "ATENDENTE", phoneNumberIdFallback);
    return sendAndSetState(phone, MSG.MENU, "MAIN", phoneNumberIdFallback);
  }

  // -------------------
  // CONTEXTO: PARTICULAR
  // -------------------
  if (ctx === "PARTICULAR") {
    if (digits === "1") return sendAndSetState(phone, MSG.LINK_AGENDAMENTO, "PARTICULAR", phoneNumberIdFallback);
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
    if (digits === "5") return sendAndSetState(phone, MSG.MEDSENIOR, "MEDSENIOR", phoneNumberIdFallback);

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
    if (digits === "1") return sendAndSetState(phone, MSG.LINK_AGENDAMENTO, "MEDSENIOR", phoneNumberIdFallback);
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

    console.log("MSG FROM:", from);
console.log("MSG RECEIVED: [hidden for privacy]");
    console.log("STATE:", getState(from));

    await handleInbound(from, text, phoneNumberIdFallback);
  } catch (err) {
    console.log("ERRO no POST /webhook:", err);
  }
});

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
    // Proteção simples (não deixa endpoint de escrita aberto na internet)
    const DEBUG_KEY = process.env.DEBUG_KEY;
    const provided = req.query.k || req.headers["x-debug-key"];
    if (!DEBUG_KEY || provided !== DEBUG_KEY) {
      return res.status(403).json({ ok: false, error: "forbidden (missing/invalid debug key)" });
    }

    // Payload (use defaults do seu teste real; pode sobrescrever via body)
    const p = req.body || {};

    const payload = {
      CodUnidade: Number(p.CodUnidade ?? 2),
      CodEspecialidade: Number(p.CodEspecialidade ?? 1003),
      CodPlano: Number(p.CodPlano ?? 2),
      CodHorario: Number(p.CodHorario),      // OBRIGATÓRIO (ex: 2012)
      CodUsuario: Number(p.CodUsuario ?? 17),
      CodColaborador: Number(p.CodColaborador ?? 3),
      BitTelemedicina: Boolean(p.BitTelemedicina ?? false),
      Confirmada: Boolean(p.Confirmada ?? true),
    };

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

// =======================
app.listen(port, () => console.log(`Server running on port ${port}`));
