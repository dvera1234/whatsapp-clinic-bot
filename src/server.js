import express from "express";

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// =======================
// CONFIG (estado mínimo)
// =======================
const STATE_TTL_MS = 15 * 60 * 1000; // 15 minutos
const lastMenuByPhone = new Map(); // phone -> { menu: string, ts: number }

function setState(phone, menu) {
  lastMenuByPhone.set(phone, { menu, ts: Date.now() });
}

function getState(phone) {
  const s = lastMenuByPhone.get(phone);
  if (!s) return null;
  if (Date.now() - s.ts > STATE_TTL_MS) {
    lastMenuByPhone.delete(phone);
    return null;
  }
  return s.menu;
}

// limpeza simples para não crescer infinito
setInterval(() => {
  const now = Date.now();
  for (const [phone, s] of lastMenuByPhone.entries()) {
    if (now - s.ts > STATE_TTL_MS) lastMenuByPhone.delete(phone);
  }
}, 5 * 60 * 1000);

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
  "5": { porBot: true, linha: null }, // MedSênior
};

// =======================
// HELPERS
// =======================
function norm(s) {
  return (s || "").trim().replace(/\s+/g, " ");
}

function onlyDigits(s) {
  const t = (s || "").trim();
  return /^[0-9]+$/.test(t) ? t : null;
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

async function sendAndSetState(phone, body, menuState) {
  await sendText(phone, body);
  if (menuState) setState(phone, menuState);
}

// =======================
// ROTEADOR COM ESTADO MÍNIMO
// =======================
async function handleInbound(phone, inboundText) {
  const raw = norm(inboundText);
  const upper = raw.toUpperCase();
  const digits = onlyDigits(raw);
  const last = getState(phone); // "MAIN" | "PARTICULAR" | "CONVENIOS" | "MEDSENIOR" | "POS" | "POS_TARDIO" | null

  // AJUDA sempre funciona
  if (upper === "AJUDA") {
    await sendAndSetState(phone, MSG.AJUDA, null);
    await sendAndSetState(phone, MSG.MENU, "MAIN");
    return;
  }

  // Se NÃO for número, sempre volta pro MENU (seu comportamento desejado)
  if (!digits) {
    await sendAndSetState(phone, MSG.MENU, "MAIN");
    return;
  }

  // Se for número, interpreta de acordo com o ÚLTIMO MENU mostrado
  // Se não tiver estado (expirou), cai no MENU principal
  const ctx = last || "MAIN";

  // ===================
  // CONTEXTO: MAIN MENU
  // ===================
  if (ctx === "MAIN") {
    if (digits === "1") {
      await sendAndSetState(phone, MSG.PARTICULAR, "PARTICULAR");
      return;
    }
    if (digits === "2") {
      await sendAndSetState(phone, MSG.CONVENIOS, "CONVENIOS");
      return;
    }
    if (digits === "3") {
      await sendAndSetState(phone, MSG.POS_MENU, "POS");
      return;
    }
    if (digits === "4") {
      await sendAndSetState(phone, MSG.ATENDENTE, "MAIN");
      // Mantém MAIN para que qualquer próxima mensagem “solta” volte ao menu
      return;
    }
    if (digits === "0") {
      await sendAndSetState(phone, MSG.MENU, "MAIN");
      return;
    }

    // número inválido -> menu
    await sendAndSetState(phone, MSG.MENU, "MAIN");
    return;
  }

  // ===================
  // CONTEXTO: PARTICULAR
  // ===================
  if (ctx === "PARTICULAR") {
    if (digits === "1") {
      await sendAndSetState(phone, MSG.LINK_AGENDAMENTO, "MAIN");
      // após mandar link, volta a MAIN (fica previsível)
      await sendAndSetState(phone, MSG.MENU, "MAIN");
      return;
    }
    if (digits === "0") {
      await sendAndSetState(phone, MSG.MENU, "MAIN");
      return;
    }
    // inválido -> menu
    await sendAndSetState(phone, MSG.MENU, "MAIN");
    return;
  }

  // ===================
  // CONTEXTO: CONVÊNIOS
  // ===================
  if (ctx === "CONVENIOS") {
    if (digits === "0") {
      await sendAndSetState(phone, MSG.MENU, "MAIN");
      return;
    }

    if (["1", "2", "3", "4", "5"].includes(digits)) {
      const c = CONVENIOS[digits];
      if (c?.porBot) {
        await sendAndSetState(phone, MSG.MEDSENIOR, "MEDSENIOR");
        return;
      }
      if (c) {
        await sendAndSetState(phone, MSG.CONVENIO_NAO_AGENDA(c.linha), "CONVENIOS_NAO_AGENDA");
        return;
      }
    }

    // inválido -> convênios de novo
    await sendAndSetState(phone, MSG.CONVENIOS, "CONVENIOS");
    return;
  }

  // ===============================
  // CONTEXTO: CONVÊNIO NÃO AGENDA
  // ===============================
  if (ctx === "CONVENIOS_NAO_AGENDA") {
    if (digits === "9") {
      await sendAndSetState(phone, MSG.PARTICULAR, "PARTICULAR");
      return;
    }
    if (digits === "0") {
      await sendAndSetState(phone, MSG.CONVENIOS, "CONVENIOS");
      return;
    }
    // inválido -> repete opções
    // (mantém o mesmo estado)
    await sendAndSetState(
      phone,
      "Escolha uma opção:\n9) Agendamento particular\n0) Voltar aos convênios",
      "CONVENIOS_NAO_AGENDA"
    );
    return;
  }

  // ===================
  // CONTEXTO: MEDSENIOR
  // ===================
  if (ctx === "MEDSENIOR") {
    if (digits === "1") {
      await sendAndSetState(phone, MSG.LINK_AGENDAMENTO, "MAIN");
      await sendAndSetState(phone, MSG.MENU, "MAIN");
      return;
    }
    if (digits === "0") {
      await sendAndSetState(phone, MSG.CONVENIOS, "CONVENIOS");
      return;
    }
    await sendAndSetState(phone, MSG.MEDSENIOR, "MEDSENIOR");
    return;
  }

  // ===================
  // CONTEXTO: PÓS-OP
  // ===================
  if (ctx === "POS") {
    if (digits === "1") {
      await sendAndSetState(phone, MSG.POS_RECENTE, "MAIN");
      await sendAndSetState(phone, MSG.MENU, "MAIN");
      return;
    }
    if (digits === "2") {
      await sendAndSetState(phone, MSG.POS_TARDIO, "POS_TARDIO");
      return;
    }
    if (digits === "0") {
      await sendAndSetState(phone, MSG.MENU, "MAIN");
      return;
    }
    await sendAndSetState(phone, MSG.POS_MENU, "POS");
    return;
  }

  // =========================
  // CONTEXTO: PÓS-OP TARDIO
  // =========================
  if (ctx === "POS_TARDIO") {
    if (digits === "1") {
      await sendAndSetState(phone, MSG.PARTICULAR, "PARTICULAR");
      return;
    }
    if (digits === "2") {
      await sendAndSetState(phone, MSG.CONVENIOS, "CONVENIOS");
      return;
    }
    if (digits === "0") {
      await sendAndSetState(phone, MSG.MENU, "MAIN");
      return;
    }
    await sendAndSetState(phone, MSG.POS_TARDIO, "POS_TARDIO");
    return;
  }

  // fallback
  await sendAndSetState(phone, MSG.MENU, "MAIN");
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

    if (body.object !== "whatsapp_business_account") return;

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;
    const text = msg.text?.body || "";

    console.log("MSG FROM:", from);
    console.log("MSG TEXT:", text);
    console.log("STATE BEFORE:", getState(from));

    await handleInbound(from, text);

    console.log("STATE AFTER:", getState(from));
  } catch (err) {
    console.log("ERRO no POST /webhook:", err);
  }
});

// =======================
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
