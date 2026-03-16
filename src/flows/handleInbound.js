import {
  touchUser,
  getState,
  setState,
  getSession,
  updateSession,
  clearSession,
  setBookingPlan,
} from "../session/redisSession.js";

import { sendText, sendButtons } from "../whatsapp/sender.js";

import {
  MSG,
  PLAN_KEYS,
  FLOW_RESET_CODE,
} from "../config/constants.js";

import {
  onlyDigits,
  onlyCpfDigits,
  normalizeDigits,
  normalizeHumanText,
} from "../utils/validators.js";

import { audit } from "../observability/audit.js";
import { maskPhone } from "../utils/mask.js";

import {
  versaFindCodUsuarioByCPF,
  versaFindCodUsuarioByDadosCPF,
  versaGetDadosUsuarioPorCodigo,
  versaHadAppointmentLast30Days,
  validatePortalCompleteness,
  versaCreatePortalCompleto,
} from "../integrations/versatilis/helpers.js";

import {
  mergeTraceMeta,
  versatilisFetch,
} from "../integrations/versatilis/client.js";

import {
  COD_COLABORADOR,
  COD_UNIDADE,
  COD_ESPECIALIDADE,
} from "../config/env.js";

async function handleInbound(phone, text, phoneNumberIdFallback, { traceId, LGPD_TEXT_VERSION, LGPD_TEXT_HASH }) {

  const phoneMasked = maskPhone(phone);

  const session = await touchUser({
    phone,
    phoneNumberIdFallback,
    sendText,
    msgEncerramento: MSG.ENCERRAMENTO,
  });

  const state = session.state || null;

  const traceMeta = {
    traceId,
    tracePhone: phoneMasked,
  };

  const input = String(text || "").trim();

  if (FLOW_RESET_CODE && input === FLOW_RESET_CODE) {
    await clearSession(phone);

    await sendText({
      to: phone,
      body: MSG.MENU,
      phoneNumberIdFallback,
    });

    await setState(phone, "MENU");

    audit("FLOW_RESET_MANUAL", {
      traceId,
      tracePhone: phoneMasked,
    });

    return;
  }

  if (!state) {
    await sendText({
      to: phone,
      body: MSG.MENU,
      phoneNumberIdFallback,
    });

    await setState(phone, "MENU");

    return;
  }

  switch (state) {

    case "MENU":
      return await handleMenu({
        phone,
        input,
        phoneNumberIdFallback,
      });

    case "LGPD_CONSENT":
      return await handleLGPD({
        phone,
        input,
        phoneNumberIdFallback,
        LGPD_TEXT_VERSION,
        LGPD_TEXT_HASH,
      });

    case "ASK_CPF":
      return await handleCPF({
        phone,
        input,
        phoneNumberIdFallback,
        traceMeta,
      });

    default:
      await sendText({
        to: phone,
        body: MSG.MENU,
        phoneNumberIdFallback,
      });

      await setState(phone, "MENU");
  }
}

export { handleInbound };

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

const SUPPORT_WA = "5519933005596";

function formatMissing(list) {
  return list.map((x) => `• ${x}`).join("\n");
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

const MIN_LEAD_HOURS = 12;
const TZ_OFFSET = "-03:00";

function slotEpochMs(isoDate, hhmm) {
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
    .filter((x) => isSlotAllowed(isoDate, x.hhmm));

  return { ok: true, slots };
}

async function fetchNextAvailableDates({ codColaborador, codUsuario, daysLookahead = 60, limit = 3 }) {
  const dates = [];
  const start = new Date();

  for (let i = 0; i < daysLookahead && dates.length < limit; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const isoDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    const out = await fetchSlotsDoDia({ codColaborador, codUsuario, isoDate });
    if (out.ok && out.slots.length > 0) {
      dates.push(isoDate);
    }
  }

  return dates;
}

function formatBRFromISO(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ""));
  if (!m) return isoDate;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

async function showNextDates({ phone, phoneNumberIdFallback, codColaborador, codUsuario }) {
  const dates = await fetchNextAvailableDates({
    codColaborador,
    codUsuario,
    daysLookahead: 60,
    limit: 3,
  });

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

async function sendAndSetState(phone, body, state, phoneNumberIdFallback) {
  const sent = await sendText({
    to: phone,
    body,
    phoneNumberIdFallback,
  });

  if (!sent) {
    return false;
  }

  if (state) {
    await setState(phone, state);
  }

  return true;
}

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

function nextWizardStateFromMissing(missingList) {
  const m = new Set((missingList || []).map((x) => String(x).toLowerCase()));

  if (m.has("nome completo")) return "WZ_NOME";
  if (m.has("data de nascimento")) return "WZ_DTNASC";
  if (m.has("e-mail")) return "WZ_EMAIL";
  if (m.has("cep")) return "WZ_CEP";
  if (m.has("endereço")) return "WZ_ENDERECO";
  if (m.has("número")) return "WZ_NUMERO";
  if (m.has("bairro")) return "WZ_BAIRRO";
  if (m.has("cidade")) return "WZ_CIDADE";
  if (m.has("estado (uf)")) return "WZ_UF";

  return "WZ_NOME";
}

async function finishWizardAndGoToDates({
  phone,
  phoneNumberIdFallback,
  codUsuario,
  planoKeyFromWizard,
  traceId = null,
}) {
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
