import express from "express";

// Se estiver usando Node 18+ no Render, fetch já existe.
// Não precisa axios.
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// =======================
// TEXTOS (MENU FIXO FINAL)
// =======================
const MSG = {
  MENU: `Olá! Sou a Cláudia, assistente virtual da clínica.

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
https://agendamento.consultorio.com

Após a confirmação, você receberá as orientações para o dia da consulta.

Se tiver qualquer dificuldade durante o agendamento,
envie uma mensagem com a palavra AJUDA.`,

  CONVENIOS: `Selecione o seu convênio:
1) GoCare
2) Samaritano
3) Salusmed
4) Proasa
5) MedSênior
0) Voltar ao menu inicial`,

  CONVENIO_NAO_AGENDA: (linha) => `Não realizamos o agendamento por aqui.

${linha}

Escolha uma opção:
9) Agendamento particular
0) Voltar aos convênios`,

  MEDSENIOR: `MedSênior

Para pacientes MedSênior, o agendamento é realizado diretamente por aqui.

📍 Consultório Livance – Campinas
Avenida Orosimbo Maia, 360
6º andar – Vila Itapura

Escolha uma opção:
1) Acesse o link de agendamento e escolha o melhor horário disponível
0) Voltar aos convênios`,

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
devem ser realizadas em consulta.`,

  POS_TARDIO: `Pós-operatório tardio
Demandas não urgentes devem ser avaliadas em consulta.

Escolha uma opção:
1) Agendamento particular
2) Agendamento convênio
0) Voltar ao menu inicial`,

  ATENDENTE: `Falar com um atendente

Este canal está disponível para apoio, dúvidas gerais
e auxílio no uso dos serviços da clínica.

Para solicitações médicas, como atestados, laudos,
relatórios ou orientações clínicas,
é necessária avaliação em consulta.

Se desejar, descreva abaixo como podemos te ajudar.`,

  AJUDA: `Entendi — vou te ajudar 🙂

Se o link não abrir, tente:
• Copiar e colar o link no navegador
• Verificar sua conexão
• Tentar novamente em alguns minutos

Se preferir, me diga qual etapa está travando (abrir link, escolher horário ou confirmar).`,
};

const CONVENIOS = {
  "1": { porBot: false, linha: "GoCare → Clínica Santé (19) 3995-0382" },
  "2": { porBot: false, linha: "Samaritano → Hosp. Samaritano Unidade 2 (19) 3738-8100 ou Pró-Consulta Sumaré (19) 3883-1314" },
  "3": { porBot: false, linha: "Salusmed → Clínica Matuda (19) 3733-1111" },
  "4": { porBot: false, linha: "Proasa → Cevisa (19) 3858-5918" },
  "5": { porBot: true, linha: null }, // MedSênior (exceção)
};

// =======================
// HELPERS
// =======================
function norm(s) {
  return (s || "").trim().replace(/\s+/g, " ").toUpperCase();
}

async function sendText(to, body) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.log("ERRO: faltam WHATSAPP_TOKEN ou WHATSAPP_PHONE_NUMBER_ID no ambiente.");
    return;
  }

  const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
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
    console.log("ERRO ao enviar mensagem:", resp.status, txt);
  }
}

// Decide respostas (stateless)
function decidirRespostas(textoBruto) {
  const t = norm(textoBruto);

  // Palavra-chave
  if (t === "AJUDA") return [MSG.AJUDA, MSG.MENU];

  // MENU principal
  if (t === "1") return [MSG.PARTICULAR, MSG.MENU];
  if (t === "2") return [MSG.CONVENIOS, MSG.MENU];
  if (t === "3") return [MSG.POS_MENU, MSG.MENU];
  if (t === "4") return [MSG.ATENDENTE, MSG.MENU];

  // Voltar menu
  if (t === "0") return [MSG.MENU];

  // Atalho particular (usado nos convênios)
  if (t === "9") return [MSG.PARTICULAR, MSG.MENU];

  // Link de agendamento (para evitar ambiguidade do "1" sem estado)
  if (t.includes("LINK") || t.includes("AGEND") || t.includes("HORAR") || t === "AGENDA") {
    return [MSG.LINK_AGENDAMENTO, MSG.MENU];
  }

  // Convênios (1-5): stateless aceita sempre
  if (["1", "2", "3", "4", "5"].includes(t)) {
    const c = CONVENIOS[t];
    if (c?.porBot) return [MSG.MEDSENIOR, MSG.MENU];
    if (c) return [MSG.CONVENIO_NAO_AGENDA(c.linha), MSG.MENU];
  }

  // Pós-op por palavras-chave (stateless)
  if (t.includes("RECENTE") || t.includes("ATÉ 30") || t.includes("ATE 30")) return [MSG.POS_RECENTE, MSG.MENU];
  if (t.includes("TARDIO") || t.includes("MAIS DE 30")) return [MSG.POS_TARDIO, MSG.MENU];

  // REGRA OPÇÃO 1: qualquer coisa -> menu
  return [MSG.MENU];
}

// =======================
// Health check
// =======================
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

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
    // responde rápido para a Meta
    res.sendStatus(200);

    console.log("=== WEBHOOK POST RECEBIDO ===");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("================================");

    const body = req.body;

    if (body.object !== "whatsapp_business_account") {
      return;
    }

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;
    const text = msg.text?.body || "";

    console.log("MSG FROM:", from);
    console.log("MSG TEXT:", text);

    const respostas = decidirRespostas(text);

    for (const r of respostas) {
      await sendText(from, r);
    }
  } catch (err) {
    console.log("ERRO no POST /webhook:", err);
  }
});

// =======================
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
