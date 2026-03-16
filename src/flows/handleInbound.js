import crypto from "crypto";

import {
  touchUser,
  getState,
  setState,
  getSession,
  updateSession,
  clearSession,
  setBookingPlan,
  redis,
} from "../session/redisSession.js";

import { sendText, sendButtons } from "../whatsapp/sender.js";

import {
  MSG,
  PLAN_KEYS,
  FLOW_RESET_CODE,
  resolveCodPlano,
} from "../config/constants.js";

import {
  onlyDigits,
  onlyCpfDigits,
  normalizeHumanText,
  normalizeSpaces,
  cleanStr,
  isValidEmail,
  normalizeCEP,
} from "../utils/validators.js";

import { parseBRDateToISO } from "../utils/time.js";
import { audit, debugLog } from "../observability/audit.js";
import { maskPhone, maskCpf } from "../utils/mask.js";

import {
  normalizePlanListFromProfile,
  hasPlanKey,
  versaFindCodUsuarioByCPF,
  versaFindCodUsuarioByDadosCPF,
  versaGetDadosUsuarioPorCodigo,
  versaHadAppointmentLast30Days,
  validatePortalCompleteness,
  versaCreatePortalCompleto,
} from "../integrations/versatilis/helpers.js";

import { versatilisFetch } from "../integrations/versatilis/client.js";

import {
  COD_COLABORADOR,
  COD_UNIDADE,
  COD_ESPECIALIDADE,
  COD_PLANO_PARTICULAR,
  PORTAL_URL,
} from "../config/env.js";

const LGPD_TEXT_VERSION = "LGPD_v1";
const LGPD_TEXT_HASH = crypto
  .createHash("sha256")
  .update(String(MSG?.LGPD_CONSENT || ""), "utf8")
  .digest("hex");

async function handleInbound(phone, inboundText, phoneNumberIdFallback, traceMeta = {}) {
  await touchUser({
    phone,
    phoneNumberIdFallback,
    sendText,
    msgEncerramento: MSG.ENCERRAMENTO,
  });

  const traceId = traceMeta?.traceId || crypto.randomUUID();

  const raw = normalizeSpaces(inboundText);
  const upper = String(raw || "").toUpperCase();
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
        (!code.startsWith("#") && msgU === "#" + codeU);

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

  const ctx = (await getState(phone)) || "MAIN";

  // =======================
  // LGPD
  // =======================
  if (ctx === "LGPD_CONSENT") {
    if (digits === "1") {
      audit("LGPD_CONSENT_ACCEPTED", {
        traceId,
        tracePhone: maskPhone(phone),
        consent: true,
        consentTextVersion: LGPD_TEXT_VERSION,
        timestamp: new Date().toISOString(),
      });

      await sendAndSetState(
        phone,
        MSG.ASK_CPF_PORTAL,
        "WZ_CPF",
        phoneNumberIdFallback
      );
      return;
    }

    if (digits === "2") {
      audit("LGPD_CONSENT_REFUSED", {
        traceId,
        tracePhone: maskPhone(phone),
        consent: false,
        consentTextVersion: LGPD_TEXT_VERSION,
        timestamp: new Date().toISOString(),
      });

      await sendText({
        to: phone,
        body: MSG.LGPD_RECUSA,
        phoneNumberIdFallback,
      });

      await clearSession(phone);
      return;
    }
  }

  // =======================
  // GLOBAL: FALAR ATENDENTE
  // =======================
  if (upper === "FALAR_ATENDENTE") {
    const s = await getSession(phone);
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

  // =======================
  // BLOQUEIO CADASTRO INCOMPLETO
  // =======================
  if (ctx === "BLOCK_EXISTING_INCOMPLETE") {
    const s = await getSession(phone);
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

  // =======================
  // ESCOLHA DE PLANO EM DIVERGÊNCIA
  // =======================
  if (ctx === "PLAN_PICK") {
    if (upper === "FALAR_ATENDENTE") {
      const s = await getSession(phone);
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

    const s = await getSession(phone);
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
  // SELEÇÃO DE DATA
  // =======================
  if (upper.startsWith("D_")) {
    const isoDate = raw.slice(2).trim();
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

  // =======================
  // AGUARDANDO DATA
  // =======================
  if (ctx === "ASK_DATE_PICK") {
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

    const shown = await showNextDates({
      phone,
      phoneNumberIdFallback,
      codColaborador,
      codUsuario,
    });

    if (shown) {
      await setState(phone, "ASK_DATE_PICK");
    }
    return;
  }

  // =======================
  // LISTA DE HORÁRIOS
  // =======================
  if (ctx === "SLOTS") {
    if (upper.startsWith("PAGE_")) {
      const n = Number(raw.split("_")[1]);

      await updateSession(phone, (sess) => {
        sess.booking = sess.booking || {};
        sess.booking.pageIndex = Number.isFinite(n) && n >= 0 ? n : 0;
      });

      const s = await getSession(phone);
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

    if (upper === "TROCAR_DATA") {
      const s = await getSession(phone);
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

      const shown = await showNextDates({
        phone,
        phoneNumberIdFallback,
        codColaborador,
        codUsuario,
      });

      if (shown) {
        await setState(phone, "ASK_DATE_PICK");
      }
      return;
    }

    if (upper.startsWith("H_")) {
      const codHorario = Number(raw.split("_")[1]);
      if (!codHorario || Number.isNaN(codHorario)) {
        await sendText({
          to: phone,
          body: "⚠️ Horário inválido.",
          phoneNumberIdFallback,
        });
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

    {
      const s = await getSession(phone);
      const slots = s?.booking?.slots || [];
      const page = Number(s?.booking?.pageIndex ?? 0) || 0;

      await showSlotsPage({ phone, phoneNumberIdFallback, slots, page });
      return;
    }
  }

  // =======================
  // CONFIRMAÇÃO DO AGENDAMENTO
  // =======================
  if (ctx === "WAIT_CONFIRM") {
    if (upper === "ESCOLHER_OUTRO") {
      const s = await getSession(phone);
      const slots = s?.booking?.slots || [];

      await updateSession(phone, (sess) => {
        delete sess.pending;
        sess.state = "SLOTS";
      });

      await showSlotsPage({ phone, phoneNumberIdFallback, slots, page: 0 });
      return;
    }

    if (upper === "CONFIRMAR") {
      const s = await getSession(phone);
      const codHorario = Number(s?.pending?.codHorario);
      const planoSelecionado = resolveCodPlano(
        s?.booking?.planoKey || PLAN_KEYS.PARTICULAR
      );

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
        const chosen = (s?.booking?.slots || []).find(
          (x) => Number(x.codHorario) === codHorario
        );

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

          const outSlots = await fetchSlotsDoDia({
            codColaborador,
            codUsuario,
            isoDate,
          });

          await updateSession(phone, (sess) => {
            sess.booking = sess.booking || {};
            sess.booking.slots = outSlots.ok ? outSlots.slots : [];
          });

          const sUpdated = await getSession(phone);

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

        audit("BOOKING_CONFIRM_FLOW", {
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
          functionalResult: !!out?.ok
            ? "BOOKING_PRESUMED_CREATED"
            : "BOOKING_NOT_CONFIRMED",
          patientFacingMessage: !!out?.ok
            ? "BOOKING_SUCCESS_WITH_PORTAL_GUIDANCE"
            : "BOOKING_FAILURE_RETRY_OR_SUPPORT",
          escalationRequired: !out?.ok,
        });

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

          audit("BOOKING_CONFIRM_PATIENT_RESPONSE", {
            traceId,
            tracePhone: maskPhone(phone),
            rid: out?.rid || null,
            httpStatus: out?.status || null,
            technicalAccepted: false,
            functionalResult: "BOOKING_NOT_CONFIRMED",
            patientFacingMessage: "BOOKING_FAILURE_RETRY_OR_SUPPORT",
            patientMessageSent: true,
            escalationRequired: true,
          });

          const slots = s?.booking?.slots || [];
          await showSlotsPage({ phone, phoneNumberIdFallback, slots, page: 0 });
          return;
        }

        const msgOk =
          out?.data?.Message ||
          out?.data?.message ||
          "Agendamento confirmado com sucesso!";

        const isParticularBooking =
          Number(payload.CodPlano) === Number(COD_PLANO_PARTICULAR);
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

          audit("BOOKING_CONFIRM_PATIENT_RESPONSE", {
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
          });
        } catch {
          audit("BOOKING_POST_CONFIRM_COMMUNICATION_FAILURE", {
            traceId,
            tracePhone: maskPhone(phone),
            rid: out?.rid || null,
            httpStatus: out?.status || null,
            technicalAccepted: true,
            functionalResult: "BOOKING_CREATED_BUT_COMMUNICATION_PARTIAL_FAILURE",
            patientFacingMessage: "BOOKING_SUCCESS_FALLBACK_MESSAGE",
            escalationRequired: false,
          });

          const fallbackSent = await sendText({
            to: phone,
            body: "✅ Agendamento confirmado. Se precisar, digite MENU para voltar.",
            phoneNumberIdFallback,
          });

          audit("BOOKING_CONFIRM_PATIENT_RESPONSE", {
            traceId,
            tracePhone: maskPhone(phone),
            rid: out?.rid || null,
            httpStatus: out?.status || null,
            technicalAccepted: true,
            functionalResult: "BOOKING_PRESUMED_CREATED",
            patientFacingMessage: "BOOKING_SUCCESS_FALLBACK_MESSAGE",
            patientMessageFallbackSent: !!fallbackSent,
            escalationRequired: false,
          });
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

  // =======================
  // AJUDA
  // =======================
  if (upper === "AJUDA") {
    await sendAndSetState(
      phone,
      MSG.AJUDA_PERGUNTA,
      "WAIT_AJUDA_MOTIVO",
      phoneNumberIdFallback
    );
    return;
  }

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

  // =======================
  // TEXTO LIVRE FORA DO WIZARD
  // =======================
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

    await resetToMain(phone, phoneNumberIdFallback);
    return;
  }

  // =======================
  // WIZARD
  // =======================
  if (String(ctx || "").startsWith("WZ_")) {
    let s = await getSession(phone);
    if (!s.portal) {
      await updateSession(phone, (sess) => {
        sess.portal = { codUsuario: null, exists: false, form: {} };
      });
      s = await getSession(phone);
    }
    if (!s.portal.form) {
      await updateSession(phone, (sess) => {
        sess.portal = sess.portal || {};
        sess.portal.form = {};
      });
      s = await getSession(phone);
    }

    // -----------------------
    // WZ_CPF
    // -----------------------
    if (ctx === "WZ_CPF") {
      const cpf = onlyCpfDigits(raw);

      if (!cpf) {
        await sendText({
          to: phone,
          body: MSG.CPF_INVALIDO,
          phoneNumberIdFallback,
        });
        return;
      }

      audit("LGPD_CONSENT_CONFIRMED_BY_IDENTIFICATION", {
        traceId,
        tracePhone: maskPhone(phone),
        cpfMasked: maskCpf(cpf),
        consentTextVersion: LGPD_TEXT_VERSION,
        consentTextHash: LGPD_TEXT_HASH,
        timestamp: new Date().toISOString(),
      });

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
          if (isValidEmail(emailExist) && !sess.portal.form.email) {
            sess.portal.form.email = emailExist;
          }

          const celExist = cleanStr(p?.Celular).replace(/\D+/g, "");
          if (celExist.length >= 10 && !sess.portal.form.celular) {
            sess.portal.form.celular = celExist;
          }

          const telExist = cleanStr(p?.Telefone).replace(/\D+/g, "");
          if (telExist.length >= 10 && !sess.portal.form.telefone) {
            sess.portal.form.telefone = telExist;
          }

          const cepExist = String(p?.CEP ?? "").replace(/\D+/g, "");
          if (cepExist.length === 8 && !sess.portal.form.cep) {
            sess.portal.form.cep = cepExist;
          }

          const endExist = cleanStr(p?.Endereco);
          if (endExist && !sess.portal.form.endereco) {
            sess.portal.form.endereco = endExist;
          }

          const numExist = cleanStr(p?.Numero);
          if (numExist && !sess.portal.form.numero) {
            sess.portal.form.numero = numExist;
          }

          const compExist = cleanStr(p?.Complemento);
          if (compExist && !sess.portal.form.complemento) {
            sess.portal.form.complemento = compExist;
          }

          const bairroExist = cleanStr(p?.Bairro);
          if (bairroExist && !sess.portal.form.bairro) {
            sess.portal.form.bairro = bairroExist;
          }

          const cidadeExist = cleanStr(p?.Cidade);
          if (cidadeExist && !sess.portal.form.cidade) {
            sess.portal.form.cidade = cidadeExist;
          }

          const dtRaw = cleanStr(p?.DtNasc);
          let dtISO = parseBRDateToISO(dtRaw) || null;

          if (!dtISO) {
            const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dtRaw);
            if (m) dtISO = `${m[1]}-${m[2]}-${m[3]}`;
          }

          if (dtISO && !sess.portal.form.dtNascISO) {
            sess.portal.form.dtNascISO = dtISO;
          }
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
        const sCurrent = await getSession(phone);
        const flowPlanKey = sCurrent?.booking?.planoKey || PLAN_KEYS.PARTICULAR;
        const plansCod = normalizePlanListFromProfile(prof.data);

        const hasParticular = hasPlanKey(plansCod, PLAN_KEYS.PARTICULAR);
        const hasMed = hasPlanKey(plansCod, PLAN_KEYS.MEDSENIOR_SP);

        await updateSession(phone, (sess) => {
          sess.booking = sess.booking || {};
          sess.booking.codUsuario = codUsuario;
        });

        if (hasParticular && !hasMed && flowPlanKey === PLAN_KEYS.PARTICULAR) {
          await finishWizardAndGoToDates({
            phone,
            phoneNumberIdFallback,
            codUsuario,
            planoKeyFromWizard: PLAN_KEYS.PARTICULAR,
            traceId,
          });
          return;
        }

        if (!hasParticular && hasMed && flowPlanKey === PLAN_KEYS.MEDSENIOR_SP) {
          await finishWizardAndGoToDates({
            phone,
            phoneNumberIdFallback,
            codUsuario,
            planoKeyFromWizard: PLAN_KEYS.MEDSENIOR_SP,
            traceId,
          });
          return;
        }

        if (hasParticular && !hasMed && flowPlanKey === PLAN_KEYS.MEDSENIOR_SP) {
          await updateSession(phone, (sess) => {
            sess.portal = sess.portal || {};
            sess.portal.issue = {
              type: "CONVENIO_NAO_HABILITADO",
              wantedPlan: "MEDSENIOR_SP",
              note: "Paciente possui apenas PARTICULAR ativo no cadastro.",
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
              `Notei que seu cadastro está como Particular.\n\n` +
              `Para agendar por MedSênior, é necessário regularizar isso com nossa equipe.\n\n` +
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

        if (!hasParticular && hasMed && flowPlanKey === PLAN_KEYS.PARTICULAR) {
          await sendButtons({
            to: phone,
            body: MSG.PLAN_DIVERGENCIA,
            buttons: [
              { id: "PL_USE_PART", title: MSG.BTN_PLAN_PART },
              { id: "PL_USE_MED", title: MSG.BTN_PLAN_MED },
            ],
            phoneNumberIdFallback,
          });

          await setState(phone, "PLAN_PICK");
          return;
        }

        await sendText({
          to: phone,
          body: "⚠️ Não consegui validar o convênio do cadastro agora. Por favor, fale com nossa equipe.",
          phoneNumberIdFallback,
        });

        await setState(phone, "MAIN");
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

    // -----------------------
    // WZ_NOME
    // -----------------------
    if (ctx === "WZ_NOME") {
      const nome = normalizeHumanText(raw, 120);

      if (!isValidName(nome)) {
        await sendText({
          to: phone,
          body: "⚠️ Envie seu nome completo.",
          phoneNumberIdFallback,
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

    // -----------------------
    // WZ_DTNASC
    // -----------------------
    if (ctx === "WZ_DTNASC") {
      const iso = parseBRDateToISO(raw);
      if (!iso) {
        await sendText({
          to: phone,
          body: "⚠️ Data inválida. Use DD/MM/AAAA.",
          phoneNumberIdFallback,
        });
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

    // -----------------------
    // WZ_SEXO
    // -----------------------
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

    // -----------------------
    // WZ_PLANO
    // -----------------------
    if (ctx === "WZ_PLANO") {
      if (upper !== "PL_PART" && upper !== "PL_MED") {
        await sendText({
          to: phone,
          body: "Use os botões para selecionar o convênio.",
          phoneNumberIdFallback,
        });
        return;
      }

      await updateSession(phone, (sess) => {
        sess.portal = sess.portal || {};
        sess.portal.form = sess.portal.form || {};
        sess.portal.form.planoKey =
          upper === "PL_MED" ? "MEDSENIOR_SP" : "PARTICULAR";
        sess.portal.form.celular = formatCellFromWA(phone);
      });

      await sendAndSetState(phone, MSG.ASK_EMAIL, "WZ_EMAIL", phoneNumberIdFallback);
      return;
    }

    // -----------------------
    // WZ_EMAIL
    // -----------------------
    if (ctx === "WZ_EMAIL") {
      const email = cleanStr(raw);
      if (!isValidEmail(email)) {
        await sendText({
          to: phone,
          body: "⚠️ E-mail inválido.",
          phoneNumberIdFallback,
        });
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

    // -----------------------
    // WZ_CEP
    // -----------------------
    if (ctx === "WZ_CEP") {
      const cep = normalizeCEP(raw);
      if (cep.length !== 8) {
        await sendText({
          to: phone,
          body: "⚠️ CEP inválido. Envie 8 dígitos.",
          phoneNumberIdFallback,
        });
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

    // -----------------------
    // WZ_ENDERECO
    // -----------------------
    if (ctx === "WZ_ENDERECO") {
      const v = normalizeHumanText(raw, 120);

      if (!isValidSimpleAddressField(v, 3, 120)) {
        await sendText({
          to: phone,
          body: "⚠️ Endereço inválido.",
          phoneNumberIdFallback,
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

    // -----------------------
    // WZ_NUMERO
    // -----------------------
    if (ctx === "WZ_NUMERO") {
      const v = normalizeHumanText(raw, 20);

      if (!v) {
        await sendText({
          to: phone,
          body: "⚠️ Informe o número.",
          phoneNumberIdFallback,
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

    // -----------------------
    // WZ_COMPLEMENTO
    // -----------------------
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

    // -----------------------
    // WZ_BAIRRO
    // -----------------------
    if (ctx === "WZ_BAIRRO") {
      const v = normalizeHumanText(raw, 80);

      if (!isValidSimpleAddressField(v, 2, 80)) {
        await sendText({
          to: phone,
          body: "⚠️ Informe o bairro.",
          phoneNumberIdFallback,
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

    // -----------------------
    // WZ_CIDADE
    // -----------------------
    if (ctx === "WZ_CIDADE") {
      const v = normalizeHumanText(raw, 80);

      if (!isValidSimpleAddressField(v, 2, 80)) {
        await sendText({
          to: phone,
          body: "⚠️ Informe a cidade.",
          phoneNumberIdFallback,
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

    // -----------------------
    // WZ_UF
    // -----------------------
    if (ctx === "WZ_UF") {
      const uf = cleanStr(raw).toUpperCase();
      if (!/^[A-Z]{2}$/.test(uf)) {
        await sendText({
          to: phone,
          body: "⚠️ UF inválida. Ex.: SP",
          phoneNumberIdFallback,
        });
        return;
      }

      const sUpdated = await updateSession(phone, (sess) => {
        sess.portal = sess.portal || {};
        sess.portal.form = sess.portal.form || {};
        sess.portal.form.uf = uf;
      });

      const up = await versaCreatePortalCompleto({
        form: sUpdated.portal.form,
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
          phoneNumberIdFallback,
        });
        await setState(phone, "MAIN");
        return;
      }

      const prof2 = await versaGetDadosUsuarioPorCodigo(up.codUsuario);
      const v2 = prof2.ok
        ? validatePortalCompleteness(prof2.data)
        : { ok: false, missing: ["dados do cadastro"] };

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

      const sFinal = await getSession(phone);
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

    await sendAndSetState(phone, MSG.ASK_CPF_PORTAL, "WZ_CPF", phoneNumberIdFallback);
    return;
  }

  // =======================
  // MENUS
  // =======================
  if (ctx === "MAIN") {
    if (digits === "1") return sendAndSetState(phone, MSG.PARTICULAR, "PARTICULAR", phoneNumberIdFallback);
    if (digits === "2") return sendAndSetState(phone, MSG.CONVENIOS, "CONVENIOS", phoneNumberIdFallback);
    if (digits === "3") return sendAndSetState(phone, MSG.POS_MENU, "POS", phoneNumberIdFallback);
    if (digits === "4") return sendAndSetState(phone, MSG.ATENDENTE, "ATENDENTE", phoneNumberIdFallback);
    return sendAndSetState(phone, MSG.MENU, "MAIN", phoneNumberIdFallback);
  }

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

      audit("LGPD_NOTICE_PRESENTED", {
        traceId,
        tracePhone: maskPhone(phone),
        consentTextVersion: LGPD_TEXT_VERSION,
        consentTextHash: LGPD_TEXT_HASH,
        timestamp: new Date().toISOString(),
      });

      await sendAndSetState(phone, MSG.LGPD_CONSENT, "LGPD_CONSENT", phoneNumberIdFallback);
      return;
    }

    if (digits === "0") return resetToMain(phone, phoneNumberIdFallback);
    return sendAndSetState(phone, MSG.PARTICULAR, "PARTICULAR", phoneNumberIdFallback);
  }

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

  if (ctx === "CONV_DETALHE") {
    if (digits === "9") return sendAndSetState(phone, MSG.PARTICULAR, "PARTICULAR", phoneNumberIdFallback);
    if (digits === "0") return resetToMain(phone, phoneNumberIdFallback);
    return sendAndSetState(phone, MSG.CONVENIOS, "CONVENIOS", phoneNumberIdFallback);
  }

  if (ctx === "MEDSENIOR") {
    if (digits === "1") {
      await updateSession(phone, (s) => {
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

      audit("LGPD_NOTICE_PRESENTED", {
        traceId,
        tracePhone: maskPhone(phone),
        consentTextVersion: LGPD_TEXT_VERSION,
        consentTextHash: LGPD_TEXT_HASH,
        timestamp: new Date().toISOString(),
      });

      await sendAndSetState(phone, MSG.LGPD_CONSENT, "LGPD_CONSENT", phoneNumberIdFallback);
      return;
    }

    if (digits === "0") return resetToMain(phone, phoneNumberIdFallback);
    return sendAndSetState(phone, MSG.MEDSENIOR, "MEDSENIOR", phoneNumberIdFallback);
  }

  if (ctx === "POS") {
    if (digits === "1") return sendAndSetState(phone, MSG.POS_RECENTE, "POS_RECENTE", phoneNumberIdFallback);
    if (digits === "2") return sendAndSetState(phone, MSG.POS_TARDIO, "POS_TARDIO", phoneNumberIdFallback);
    if (digits === "0") return resetToMain(phone, phoneNumberIdFallback);
    return sendAndSetState(phone, MSG.POS_MENU, "POS", phoneNumberIdFallback);
  }

  if (ctx === "POS_RECENTE") {
    if (digits === "0") return resetToMain(phone, phoneNumberIdFallback);
    return sendAndSetState(phone, MSG.POS_RECENTE, "POS_RECENTE", phoneNumberIdFallback);
  }

  if (ctx === "POS_TARDIO") {
    if (digits === "1") return sendAndSetState(phone, MSG.PARTICULAR, "PARTICULAR", phoneNumberIdFallback);
    if (digits === "2") return sendAndSetState(phone, MSG.CONVENIOS, "CONVENIOS", phoneNumberIdFallback);
    if (digits === "0") return resetToMain(phone, phoneNumberIdFallback);
    return sendAndSetState(phone, MSG.POS_TARDIO, "POS_TARDIO", phoneNumberIdFallback);
  }

  if (ctx === "ATENDENTE") {
    if (digits === "0") return resetToMain(phone, phoneNumberIdFallback);
    return sendAndSetState(
      phone,
      "Por favor, descreva abaixo como podemos te ajudar.",
      "ATENDENTE",
      phoneNumberIdFallback
    );
  }

  return sendAndSetState(phone, MSG.MENU, "MAIN", phoneNumberIdFallback);
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

function getPromptByWizardState(state) {
  switch (state) {
    case "WZ_NOME":
      return MSG.ASK_NOME;
    case "WZ_DTNASC":
      return MSG.ASK_DTNASC;
    case "WZ_EMAIL":
      return MSG.ASK_EMAIL;
    case "WZ_CEP":
      return MSG.ASK_CEP;
    case "WZ_ENDERECO":
      return MSG.ASK_ENDERECO;
    case "WZ_NUMERO":
      return MSG.ASK_NUMERO;
    case "WZ_COMPLEMENTO":
      return MSG.ASK_COMPLEMENTO;
    case "WZ_BAIRRO":
      return MSG.ASK_BAIRRO;
    case "WZ_CIDADE":
      return MSG.ASK_CIDADE;
    case "WZ_UF":
      return MSG.ASK_UF;
    default:
      return MSG.ASK_NOME;
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

function formatCellFromWA(phone) {
  return String(phone || "").replace(/\D+/g, "");
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

function makeWaLink(prefillText) {
  const encoded = encodeURIComponent(prefillText);
  return `https://wa.me/${SUPPORT_WA}?text=${encoded}`;
}

async function sendSupportLink({
  phone,
  phoneNumberIdFallback,
  prefill,
  nextState = "MAIN",
}) {
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

async function fetchNextAvailableDates({
  codColaborador,
  codUsuario,
  daysLookahead = 60,
  limit = 3,
}) {
  const dates = [];
  const start = new Date();

  for (let i = 0; i < daysLookahead && dates.length < limit; i++) {
    const d = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + i
    );

    const isoDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      "0"
    )}-${String(d.getDate()).padStart(2, "0")}`;

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

async function showNextDates({
  phone,
  phoneNumberIdFallback,
  codColaborador,
  codUsuario,
}) {
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
