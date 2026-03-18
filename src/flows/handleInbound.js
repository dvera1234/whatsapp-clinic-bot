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
import { MSG, PLAN_KEYS, FLOW_RESET_CODE } from "../config/constants.js";
import { buildTenantRuntime } from "../tenants/buildTenantRuntime.js";

import { createPatientAdapter } from "../integrations/adapters/factories/createPatientAdapter.js";
import { createPortalAdapter } from "../integrations/adapters/factories/createPortalAdapter.js";
import { createSchedulingAdapter } from "../integrations/adapters/factories/createSchedulingAdapter.js";

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

const LGPD_TEXT_VERSION = "LGPD_v1";
const LGPD_TEXT_HASH = crypto
  .createHash("sha256")
  .update(String(MSG?.LGPD_CONSENT || ""), "utf8")
  .digest("hex");

const MIN_LEAD_HOURS = 12;
const TZ_OFFSET = "-03:00";

async function handleInbound({
  context = {},
  phone,
  text: inboundText,
  phoneNumberIdFallback,
}) {
  const traceId = String(context?.traceId || crypto.randomUUID());
  const tenantId = String(context?.tenantId || "").trim();
  const tenantConfig = context?.tenantConfig || {};
  const effectivePhoneNumberId =
    context?.phoneNumberId || phoneNumberIdFallback || null;

  if (!tenantId) {
    audit("TENANT_CONTEXT_MISSING", {
      traceId,
      tracePhone: maskPhone(phone),
      hasContext: !!context,
      hasPhoneNumberId: !!effectivePhoneNumberId,
      blockedBeforeFlow: true,
    });
    return;
  }

  const tenantRuntime = buildTenantRuntime(tenantConfig);

  if (!tenantRuntime?.ok || !tenantRuntime?.value) {
    audit("TENANT_CONFIG_INVALID", {
      tenantId,
      traceId,
      tracePhone: maskPhone(phone),
      missingFields: tenantRuntime?.missing || [],
      invalidFields: tenantRuntime?.invalid || [],
      blockedBeforeFlow: true,
    });

    await failSafeTenantConfigError({
      tenantId,
      phone,
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
    return;
  }

  const runtime = tenantRuntime.value;

  const patientAdapter = createPatientAdapter(runtime);
  const portalAdapter = createPortalAdapter(runtime);
  const schedulingAdapter = createSchedulingAdapter(runtime);

  const codColaborador = runtime?.clinic?.codColaborador ?? null;
  const codUnidade = runtime?.clinic?.codUnidade ?? null;
  const codEspecialidade = runtime?.clinic?.codEspecialidade ?? null;

  const codPlanoParticular = runtime?.plans?.codPlanoParticular ?? null;
  const codPlanoMedSeniorSp = runtime?.plans?.codPlanoMedSeniorSp ?? null;

  const portalUrl = runtime?.portal?.url || "";
  const supportWa = runtime?.support?.waNumber || "";

  const runtimeCtx = {
    tenantId,
    tenantConfig,
    tenantRuntime: runtime,
    traceId,
    tracePhone: maskPhone(phone),
    codPlanoParticular,
    codPlanoMedSeniorSp,
  };

  const raw = normalizeSpaces(inboundText);
  const upper = String(raw || "").toUpperCase();
  const digits = onlyDigits(raw);

  await touchUser({
    tenantId,
    phone,
    phoneNumberIdFallback: effectivePhoneNumberId,
  });

  const currentState = (await getState(tenantId, phone)) || "MAIN";
  const ctx = currentState;

  debugLog("FLOW_INBOUND_RECEIVED", {
    tenantId,
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
      const withHashU = `#${code}`.toUpperCase();

      const hit =
        msgU === codeU ||
        msgU === withHashU ||
        (code.startsWith("#") && msgU === codeU) ||
        (!code.startsWith("#") && msgU === `#${codeU}`);

      if (hit) {
        audit("FLOW_RESET_TRIGGERED", {
          tenantId,
          traceId,
          tracePhone: maskPhone(phone),
          stateBeforeReset: currentState,
        });

        await clearSession(tenantId, phone);

        await sendAndSetState({
          tenantId,
          phone,
          body: MSG.MENU,
          state: "MAIN",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        return;
      }
    }
  }

  if (ctx === "LGPD_CONSENT") {
    if (digits === "1") {
      audit("LGPD_CONSENT_ACCEPTED", {
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        consent: true,
        consentTextVersion: LGPD_TEXT_VERSION,
        consentTextHash: LGPD_TEXT_HASH,
        timestamp: new Date().toISOString(),
      });

      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.ASK_CPF_PORTAL,
        state: "WZ_CPF",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      return;
    }

    if (digits === "2") {
      audit("LGPD_CONSENT_REFUSED", {
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        consent: false,
        consentTextVersion: LGPD_TEXT_VERSION,
        consentTextHash: LGPD_TEXT_HASH,
        timestamp: new Date().toISOString(),
      });

      await sendText({
        tenantId,
        to: phone,
        body: MSG.LGPD_RECUSA,
        phoneNumberIdFallback: effectivePhoneNumberId,
      });

      await clearSession(tenantId, phone);
      return;
    }
  }

  if (upper === "FALAR_ATENDENTE") {
    const s = await getSession(tenantId, phone);
    const prefill = buildSupportPrefillFromSession(phone, s, traceId, tenantId);

    await sendSupportLink({
      tenantId,
      phone,
      phoneNumberIdFallback: effectivePhoneNumberId,
      prefill,
      supportWa,
      nextState: "MAIN",
    });

    await clearTransientPortalData(tenantId, phone);
    return;
  }

  if (ctx === "BLOCK_EXISTING_INCOMPLETE") {
    const s = await getSession(tenantId, phone);
    const faltas = Array.isArray(s?.portal?.missing) ? s.portal.missing : [];

    const prefill = buildSafeSupportPrefill({
      tenantId,
      traceId,
      phone,
      reason: "Cadastro incompleto no Portal do Paciente.",
      missing: faltas,
    });

    await sendSupportLink({
      tenantId,
      phone,
      phoneNumberIdFallback: effectivePhoneNumberId,
      prefill,
      supportWa,
      nextState: "MAIN",
    });

    await clearTransientPortalData(tenantId, phone);
    return;
  }

  if (ctx === "PLAN_PICK") {
    if (upper === "FALAR_ATENDENTE") {
      const s = await getSession(tenantId, phone);
      const prefill = buildSupportPrefillFromSession(phone, s, traceId, tenantId);

      await sendSupportLink({
        tenantId,
        phone,
        phoneNumberIdFallback: effectivePhoneNumberId,
        prefill,
        supportWa,
        nextState: "MAIN",
      });

      await clearTransientPortalData(tenantId, phone);
      return;
    }

    if (upper !== "PL_USE_PART" && upper !== "PL_USE_MED") {
      await sendText({
        tenantId,
        to: phone,
        body: "Use os botões apresentados para prosseguir.",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      return;
    }

    const chosenKey =
      upper === "PL_USE_MED" ? PLAN_KEYS.MEDSENIOR_SP : PLAN_KEYS.PARTICULAR;

    await updateSession(tenantId, phone, (sess) => {
      sess.booking = sess.booking || {};
      sess.booking.planoKey = chosenKey;

      if (sess.portal?.issue) {
        delete sess.portal.issue;
      }
    });

    const s = await getSession(tenantId, phone);
    const codUsuario = Number(s?.booking?.codUsuario || s?.portal?.codUsuario);

    if (!codUsuario) {
      await sendText({
        tenantId,
        to: phone,
        body: "⚠️ Sessão inválida. Digite 1 para iniciar novamente.",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      await setState(tenantId, phone, "MAIN");
      return;
    }

    await finishWizardAndGoToDates({
      schedulingAdapter,
      tenantId,
      tenantConfig,
      phone,
      phoneNumberIdFallback: effectivePhoneNumberId,
      codUsuario,
      planoKeyFromWizard: chosenKey,
      traceId,
      codColaborador,
      codPlanoParticular,
      codPlanoMedSeniorSp,
    });

    return;
  }

  if (upper.startsWith("D_")) {
    const isoDate = raw.slice(2).trim();
    const s = await getSession(tenantId, phone);

    const bookingCodColaborador = s?.booking?.codColaborador ?? codColaborador;
    const codUsuario = s?.booking?.codUsuario;

    if (!codUsuario) {
      await sendText({
        tenantId,
        to: phone,
        body: "⚠️ Sessão inválida. Digite 1 para iniciar novamente.",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      await setState(tenantId, phone, "MAIN");
      return;
    }

    const out = await fetchSlotsDoDia({
      schedulingAdapter,
      tenantId,
      tenantConfig,
      traceId,
      codColaborador: bookingCodColaborador,
      codUsuario,
      isoDate,
      phone,
    });
    const slots = out.ok ? out.slots : [];

    await updateSession(tenantId, phone, (sess) => {
      sess.booking = {
        ...(sess.booking || {}),
        codColaborador: bookingCodColaborador,
        codUsuario,
        isoDate,
        pageIndex: 0,
        slots,
      };
    });

    await setState(tenantId, phone, "SLOTS");
    await showSlotsPage({
      tenantId,
      phone,
      phoneNumberIdFallback: effectivePhoneNumberId,
      slots,
      page: 0,
    });
    return;
  }

  if (ctx === "ASK_DATE_PICK") {
    const s = await getSession(tenantId, phone);
    const bookingCodColaborador = s?.booking?.codColaborador ?? codColaborador;
    const codUsuario = s?.booking?.codUsuario;

    if (!codUsuario) {
      await sendText({
        tenantId,
        to: phone,
        body: "⚠️ Sessão inválida. Digite 1 para iniciar novamente.",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      await setState(tenantId, phone, "MAIN");
      return;
    }

    const shown = await showNextDates({
      schedulingAdapter,
      tenantId,
      tenantConfig,
      phone,
      phoneNumberIdFallback: effectivePhoneNumberId,
      codColaborador: bookingCodColaborador,
      codUsuario,
      traceId,
    });

    if (shown) {
      await setState(tenantId, phone, "ASK_DATE_PICK");
    }
    return;
  }

  if (ctx === "SLOTS") {
    if (upper.startsWith("PAGE_")) {
      const n = Number(raw.split("_")[1]);

      await updateSession(tenantId, phone, (sess) => {
        sess.booking = sess.booking || {};
        sess.booking.pageIndex = Number.isFinite(n) && n >= 0 ? n : 0;
      });

      const s = await getSession(tenantId, phone);
      const slots = s?.booking?.slots || [];
      const page = Number(s?.booking?.pageIndex ?? 0) || 0;

      await showSlotsPage({
        tenantId,
        phone,
        phoneNumberIdFallback: effectivePhoneNumberId,
        slots,
        page,
      });
      return;
    }

    if (upper === "TROCAR_DATA") {
      const s = await getSession(tenantId, phone);
      const bookingCodColaborador = s?.booking?.codColaborador ?? codColaborador;
      const codUsuario = s?.booking?.codUsuario;

      await updateSession(tenantId, phone, (sess) => {
        if (sess?.booking) {
          sess.booking.isoDate = null;
          sess.booking.slots = [];
          sess.booking.pageIndex = 0;
        }
      });

      if (!codUsuario) {
        await sendText({
          tenantId,
          to: phone,
          body: "⚠️ Sessão inválida. Digite 1 para iniciar novamente.",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        await setState(tenantId, phone, "MAIN");
        return;
      }

      const shown = await showNextDates({
        schedulingAdapter,
        tenantId,
        tenantConfig,
        phone,
        phoneNumberIdFallback: effectivePhoneNumberId,
        codColaborador: bookingCodColaborador,
        codUsuario,
        traceId,
      });

      if (shown) {
        await setState(tenantId, phone, "ASK_DATE_PICK");
      }
      return;
    }

    if (upper.startsWith("H_")) {
      const codHorario = Number(raw.split("_")[1]);
      if (!codHorario || Number.isNaN(codHorario)) {
        await sendText({
          tenantId,
          to: phone,
          body: "⚠️ Horário inválido.",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        return;
      }

      await updateSession(tenantId, phone, (s) => {
        s.pending = { codHorario };
      });

      await setState(tenantId, phone, "WAIT_CONFIRM");
      await sendButtons({
        tenantId,
        to: phone,
        body: "✅ Horário selecionado.\n\nDeseja confirmar este horário?",
        buttons: [
          { id: "CONFIRMAR", title: "Confirmar" },
          { id: "ESCOLHER_OUTRO", title: "Escolher outro" },
        ],
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      return;
    }

    {
      const s = await getSession(tenantId, phone);
      const slots = s?.booking?.slots || [];
      const page = Number(s?.booking?.pageIndex ?? 0) || 0;

      await showSlotsPage({
        tenantId,
        phone,
        phoneNumberIdFallback: effectivePhoneNumberId,
        slots,
        page,
      });
      return;
    }
  }

  if (ctx === "WAIT_CONFIRM") {
    if (upper === "ESCOLHER_OUTRO") {
      const s = await getSession(tenantId, phone);
      const slots = s?.booking?.slots || [];

      await updateSession(tenantId, phone, (sess) => {
        delete sess.pending;
      });

      await setState(tenantId, phone, "SLOTS");
      await showSlotsPage({
        tenantId,
        phone,
        phoneNumberIdFallback: effectivePhoneNumberId,
        slots,
        page: 0,
      });
      return;
    }

    if (upper === "CONFIRMAR") {
      const s = await getSession(tenantId, phone);
      const codHorario = Number(s?.pending?.codHorario);
      const planoSelecionado = resolvePlanCodeFromRuntime(
        s?.booking?.planoKey || PLAN_KEYS.PARTICULAR,
        {
          codPlanoParticular,
          codPlanoMedSeniorSp,
        }
      );

      const payload = {
        CodUnidade: codUnidade,
        CodEspecialidade: codEspecialidade,
        CodPlano: planoSelecionado,
        CodHorario: codHorario,
        CodUsuario: s?.booking?.codUsuario,
        CodColaborador: s?.booking?.codColaborador ?? codColaborador,
        BitTelemedicina: false,
        Confirmada: true,
      };

      if (!payload.CodUsuario) {
        await sendText({
          tenantId,
          to: phone,
          body: "⚠️ Não consegui identificar o paciente. Digite AJUDA.",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        await setState(tenantId, phone, "MAIN");
        return;
      }

      if (!codHorario || Number.isNaN(codHorario)) {
        const slots = s?.booking?.slots || [];

        await updateSession(tenantId, phone, (sess) => {
          delete sess.pending;
        });

        await setState(tenantId, phone, "SLOTS");
        await sendText({
          tenantId,
          to: phone,
          body: "⚠️ Não encontrei o horário selecionado. Escolha novamente.",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });

        await showSlotsPage({
          tenantId,
          phone,
          phoneNumberIdFallback: effectivePhoneNumberId,
          slots,
          page: 0,
        });
        return;
      }

      const bookingKey = bookingConfirmKey(tenantId, phone, codHorario);
      const lockOk = await redis.set(bookingKey, "1", { ex: 60, nx: true });

      if (!lockOk) {
        await sendText({
          tenantId,
          to: phone,
          body: "⏳ Seu agendamento já está sendo processado. Aguarde alguns segundos.",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        return;
      }

      try {
        const isoDate = s?.booking?.isoDate;
        const chosen = (s?.booking?.slots || []).find(
          (x) => Number(x.codHorario) === codHorario
        );

        if (!isoDate || !chosen?.hhmm || !isSlotAllowed(isoDate, chosen.hhmm)) {
          await updateSession(tenantId, phone, (sess) => {
            delete sess.pending;
          });

          await setState(tenantId, phone, "SLOTS");
          await sendText({
            tenantId,
            to: phone,
            body: "⚠️ Este horário não pode mais ser agendado (mínimo de 12h). Escolha outro.",
            phoneNumberIdFallback: effectivePhoneNumberId,
          });

          const bookingCodColaborador =
            s?.booking?.codColaborador ?? codColaborador;
          const codUsuario = s?.booking?.codUsuario;

          if (!codUsuario) {
            await sendText({
              tenantId,
              to: phone,
              body: "⚠️ Sessão inválida. Digite 1 para iniciar novamente.",
              phoneNumberIdFallback: effectivePhoneNumberId,
            });
            await setState(tenantId, phone, "MAIN");
            return;
          }

          const outSlots = await fetchSlotsDoDia({
            schedulingAdapter,
            tenantId,
            tenantConfig,
            traceId,
            codColaborador: bookingCodColaborador,
            codUsuario,
            isoDate,
            phone,
          });

          await updateSession(tenantId, phone, (sess) => {
            sess.booking = sess.booking || {};
            sess.booking.slots = outSlots.ok ? outSlots.slots : [];
          });

          const sUpdated = await getSession(tenantId, phone);

          await showSlotsPage({
            tenantId,
            phone,
            phoneNumberIdFallback: effectivePhoneNumberId,
            slots: sUpdated?.booking?.slots || [],
            page: 0,
          });
          return;
        }

        const out = await schedulingAdapter.confirmarAgendamento({
          tenantId,
          tenantConfig,
          payload,
          traceMeta: {
            tenantId,
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
          tenantId,
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
          await updateSession(tenantId, phone, (sess) => {
            delete sess.pending;
          });

          await setState(tenantId, phone, "SLOTS");
          await sendText({
            tenantId,
            to: phone,
            body: "⚠️ Não consegui confirmar agora. Tente outro horário ou digite AJUDA.",
            phoneNumberIdFallback: effectivePhoneNumberId,
          });

          audit("BOOKING_CONFIRM_PATIENT_RESPONSE", {
            tenantId,
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
          await showSlotsPage({
            tenantId,
            phone,
            phoneNumberIdFallback: effectivePhoneNumberId,
            slots,
            page: 0,
          });
          return;
        }

        const msgOk =
          out?.data?.Message ||
          out?.data?.message ||
          "Agendamento confirmado com sucesso!";

        const isParticularBooking =
          Number(payload.CodPlano) === Number(codPlanoParticular);
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
          await setState(tenantId, phone, "MAIN");

          const sentMainSuccess = await sendText({
            tenantId,
            to: phone,
            body: `✅ ${msgOk}\n\n${ORIENTACOES}\n\n${PORTAL_INFO}`,
            phoneNumberIdFallback: effectivePhoneNumberId,
          });

          let sentPortalLink = false;
          if (portalUrl) {
            sentPortalLink = await sendText({
              tenantId,
              to: phone,
              body: `🔗 Portal do Paciente:\n${portalUrl}`,
              phoneNumberIdFallback: effectivePhoneNumberId,
            });
          }

          audit("BOOKING_CONFIRM_PATIENT_RESPONSE", {
            tenantId,
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
            tenantId,
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
            tenantId,
            to: phone,
            body: "✅ Agendamento confirmado. Se precisar, digite MENU para voltar.",
            phoneNumberIdFallback: effectivePhoneNumberId,
          });

          audit("BOOKING_CONFIRM_PATIENT_RESPONSE", {
            tenantId,
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
      tenantId,
      to: phone,
      body: "Use os botões abaixo:",
      buttons: [
        { id: "CONFIRMAR", title: "Confirmar" },
        { id: "ESCOLHER_OUTRO", title: "Escolher outro" },
      ],
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
    return;
  }

  if (upper === "AJUDA") {
    await sendAndSetState({
      tenantId,
      phone,
      body: MSG.AJUDA_PERGUNTA,
      state: "WAIT_AJUDA_MOTIVO",
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
    return;
  }

  if (ctx === "WAIT_AJUDA_MOTIVO") {
    const prefill = buildSafeSupportPrefill({
      tenantId,
      traceId,
      phone,
      reason: "Paciente relatou dificuldade no agendamento.",
      details: raw,
    });

    await sendSupportLink({
      tenantId,
      phone,
      phoneNumberIdFallback: effectivePhoneNumberId,
      prefill,
      supportWa,
      nextState: "MAIN",
    });

    await clearTransientPortalData(tenantId, phone);
    return;
  }

  if (!digits && !String(ctx || "").startsWith("WZ_")) {
    if (ctx === "ATENDENTE") {
      const prefill = buildSafeSupportPrefill({
        tenantId,
        traceId,
        phone,
        reason: "Paciente solicitou atendimento humano.",
        details: raw,
      });

      await sendSupportLink({
        tenantId,
        phone,
        phoneNumberIdFallback: effectivePhoneNumberId,
        prefill,
        supportWa,
        nextState: "MAIN",
      });

      await clearTransientPortalData(tenantId, phone);
      return;
    }

    await resetToMain(tenantId, phone, effectivePhoneNumberId);
    return;
  }

  if (String(ctx || "").startsWith("WZ_")) {
    let s = await getSession(tenantId, phone);

    if (!s.portal) {
      await updateSession(tenantId, phone, (sess) => {
        sess.portal = { codUsuario: null, exists: false, form: {} };
      });
      s = await getSession(tenantId, phone);
    }

    if (!s.portal.form) {
      await updateSession(tenantId, phone, (sess) => {
        sess.portal = sess.portal || {};
        sess.portal.form = {};
      });
      s = await getSession(tenantId, phone);
    }

    if (ctx === "WZ_CPF") {
      const cpf = onlyCpfDigits(raw);

      if (!cpf) {
        await sendText({
          tenantId,
          to: phone,
          body: MSG.CPF_INVALIDO,
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        return;
      }

      audit("LGPD_CONSENT_CONFIRMED_BY_IDENTIFICATION", {
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        cpfMasked: maskCpf(cpf),
        consentTextVersion: LGPD_TEXT_VERSION,
        consentTextHash: LGPD_TEXT_HASH,
        timestamp: new Date().toISOString(),
      });

      debugLog("PATIENT_CPF_RECEIVED_FOR_IDENTIFICATION", {
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        cpfMasked: "***",
      });

      const codUsuario =
        await patientAdapter.buscarPacientePorCpfComFallback({
          cpf,
          runtimeCtx,
        });

      debugLog("PATIENT_CPF_IDENTIFICATION_RESULT", {
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        cpfMasked: "***",
        codUsuarioFound: !!codUsuario,
        codUsuario: codUsuario || null,
      });

      if (!codUsuario) {
        // ✅ INÍCIO CORRETO DO CADASTRO NOVO
      
        await updateSession(tenantId, phone, (s) => {
          s.portal = s.portal || {};
          s.portal.exists = false;
          s.portal.form = s.portal.form || {};
          s.portal.form.cpf = cpfDigits;
        });
      
        await sendText({
          tenantId,
          to: phone,
          body: "Perfeito! Vamos fazer seu cadastro 😊\n\nDigite seu *nome completo*:",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
      
        await setState(tenantId, phone, "WZ_NOME");
        return;
      }

      await updateSession(tenantId, phone, (sess) => {
        sess.portal = sess.portal || {};
        sess.portal.form = sess.portal.form || {};
        sess.portal.form.cpf = cpf;
        sess.portal.exists = true;
        sess.portal.codUsuario = codUsuario;
      });

      const prof = await patientAdapter.buscarPerfilPaciente({
        codUsuario,
        runtimeCtx,
      });

      if (prof.ok && prof.data) {
        const p = prof.data;

        await updateSession(tenantId, phone, (sess) => {
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
          tenantId,
          to: phone,
          body: "⚠️ Encontrei seu cadastro, mas não consegui consultar seus dados agora. Por favor, fale com nossa equipe.",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        await setState(tenantId, phone, "MAIN");
        return;
      }

      const v = patientAdapter.validarCadastroCompleto({
        perfil: prof.data,
      });

      if (v.ok) {
        const sCurrent = await getSession(tenantId, phone);
        const flowPlanKey = sCurrent?.booking?.planoKey || PLAN_KEYS.PARTICULAR;
        const plansCod = patientAdapter.normalizarPlanosAtivos({
          perfil: prof.data,
        });

        const hasParticular = patientAdapter.temPlano({
          plansCod,
          planKey: PLAN_KEYS.PARTICULAR,
          runtimeCtx,
        });

        const hasMed = patientAdapter.temPlano({
          plansCod,
          planKey: PLAN_KEYS.MEDSENIOR_SP,
          runtimeCtx,
        });

        await updateSession(tenantId, phone, (sess) => {
          sess.booking = sess.booking || {};
          sess.booking.codUsuario = codUsuario;
        });

        if (hasParticular && !hasMed && flowPlanKey === PLAN_KEYS.PARTICULAR) {
          await finishWizardAndGoToDates({
            schedulingAdapter,
            tenantId,
            tenantConfig,
            phone,
            phoneNumberIdFallback: effectivePhoneNumberId,
            codUsuario,
            planoKeyFromWizard: flowPlanKey,
            traceId,
            codColaborador,
            codPlanoParticular,
            codPlanoMedSeniorSp,
          });
          return;
        }

        if (!hasParticular && hasMed && flowPlanKey === PLAN_KEYS.MEDSENIOR_SP) {
          await finishWizardAndGoToDates({
            schedulingAdapter,
            tenantId,
            tenantConfig,
            phone,
            phoneNumberIdFallback: effectivePhoneNumberId,
            codUsuario,
            planoKeyFromWizard: flowPlanKey,
            traceId,
            codColaborador,
            codPlanoParticular,
            codPlanoMedSeniorSp,
          });
          return;
        }

        if (hasParticular && !hasMed && flowPlanKey === PLAN_KEYS.MEDSENIOR_SP) {
          await updateSession(tenantId, phone, (sess) => {
            sess.portal = sess.portal || {};
            sess.portal.issue = {
              type: "CONVENIO_NAO_HABILITADO",
              wantedPlan: "MEDSENIOR_SP",
              note: "Paciente possui apenas PARTICULAR ativo no cadastro.",
              codUsuario: Number(codUsuario) || null,
              plansDetected: Array.isArray(plansCod)
                ? plansCod.map(Number)
                : [],
            };
          });

          audit("PLAN_INCONSISTENCY_MEDSENIOR_NOT_ENABLED", {
            tenantId,
            traceId,
            tracePhone: maskPhone(phone),
            codUsuario: Number(codUsuario) || null,
            flowPlanKey,
            plansDetected: Array.isArray(plansCod)
              ? plansCod.map(Number)
              : [],
            escalationRequired: true,
          });

          await sendButtons({
            tenantId,
            to: phone,
            body:
              `Notei que seu cadastro está como Particular.\n\n` +
              `Para agendar por MedSênior, é necessário regularizar isso com nossa equipe.\n\n` +
              `Como deseja prosseguir?`,
            buttons: [
              { id: "PL_USE_PART", title: MSG.BTN_PLAN_PART },
              { id: "FALAR_ATENDENTE", title: MSG.BTN_FALAR_ATENDENTE },
            ],
            phoneNumberIdFallback: effectivePhoneNumberId,
          });

          await setState(tenantId, phone, "PLAN_PICK");
          return;
        }

        if (!hasParticular && hasMed && flowPlanKey === PLAN_KEYS.PARTICULAR) {
          await sendButtons({
            tenantId,
            to: phone,
            body: MSG.PLAN_DIVERGENCIA,
            buttons: [
              { id: "PL_USE_PART", title: MSG.BTN_PLAN_PART },
              { id: "PL_USE_MED", title: MSG.BTN_PLAN_MED },
            ],
            phoneNumberIdFallback: effectivePhoneNumberId,
          });

          await setState(tenantId, phone, "PLAN_PICK");
          return;
        }

        await sendText({
          tenantId,
          to: phone,
          body: "⚠️ Não consegui validar o convênio do cadastro agora. Por favor, fale com nossa equipe.",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });

        await setState(tenantId, phone, "MAIN");
        return;
      }

      await updateSession(tenantId, phone, (sess) => {
        sess.portal = sess.portal || {};
        sess.portal.missing = v.missing;
      });

      audit("PORTAL_EXISTING_USER_BLOCKED_INCOMPLETE_PROFILE", {
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        codUsuario: codUsuario || null,
        missingFields: Array.isArray(v.missing) ? v.missing : [],
        escalationRequired: true,
      });

      await sendButtons({
        tenantId,
        to: phone,
        body: MSG.PORTAL_EXISTENTE_INCOMPLETO_BLOQUEIO(
          formatMissing(v.missing)
        ),
        buttons: [{ id: "FALAR_ATENDENTE", title: MSG.BTN_FALAR_ATENDENTE }],
        phoneNumberIdFallback: effectivePhoneNumberId,
      });

      await setState(tenantId, phone, "BLOCK_EXISTING_INCOMPLETE");
      return;
    }

    if (ctx === "WZ_NOME") {
      const nome = normalizeHumanText(raw, 120);

      if (!isValidName(nome)) {
        await sendText({
          tenantId,
          to: phone,
          body: "⚠️ Envie seu nome completo.",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        return;
      }

      await updateSession(tenantId, phone, (sess) => {
        sess.portal = sess.portal || {};
        sess.portal.form = sess.portal.form || {};
        sess.portal.form.nome = nome;
      });

      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.ASK_DTNASC,
        state: "WZ_DTNASC",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      return;
    }

    if (ctx === "WZ_DTNASC") {
      const iso = parseBRDateToISO(raw);
      if (!iso) {
        await sendText({
          tenantId,
          to: phone,
          body: "⚠️ Data inválida. Use DD/MM/AAAA.",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        return;
      }

      await updateSession(tenantId, phone, (sess) => {
        sess.portal = sess.portal || {};
        sess.portal.form = sess.portal.form || {};
        sess.portal.form.dtNascISO = iso;
      });

      await sendButtons({
        tenantId,
        to: phone,
        body: "Sexo :",
        buttons: [
          { id: "SX_M", title: "Masculino" },
          { id: "SX_F", title: "Feminino" },
          { id: "SX_NI", title: "Prefiro não informar" },
        ],
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      await setState(tenantId, phone, "WZ_SEXO");
      return;
    }

    if (ctx === "WZ_SEXO") {
      await updateSession(tenantId, phone, (sess) => {
        sess.portal = sess.portal || {};
        sess.portal.form = sess.portal.form || {};

        if (upper === "SX_M") sess.portal.form.sexoOpt = "M";
        else if (upper === "SX_F") sess.portal.form.sexoOpt = "F";
        else sess.portal.form.sexoOpt = "NI";
      });

      await sendButtons({
        tenantId,
        to: phone,
        body: "Selecione o convênio para este agendamento:",
        buttons: [
          { id: "PL_PART", title: "Particular" },
          { id: "PL_MED", title: "MedSênior SP" },
        ],
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      await setState(tenantId, phone, "WZ_PLANO");
      return;
    }

    if (ctx === "WZ_PLANO") {
      if (upper !== "PL_PART" && upper !== "PL_MED") {
        await sendText({
          tenantId,
          to: phone,
          body: "Use os botões para selecionar o convênio.",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        return;
      }

      await updateSession(tenantId, phone, (sess) => {
        sess.portal = sess.portal || {};
        sess.portal.form = sess.portal.form || {};
        sess.portal.form.planoKey =
          upper === "PL_MED" ? PLAN_KEYS.MEDSENIOR_SP : PLAN_KEYS.PARTICULAR;
        sess.portal.form.celular = formatCellFromWA(phone);
      });

      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.ASK_EMAIL,
        state: "WZ_EMAIL",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      return;
    }

    if (ctx === "WZ_EMAIL") {
      const email = cleanStr(raw);
      if (!isValidEmail(email)) {
        await sendText({
          tenantId,
          to: phone,
          body: "⚠️ E-mail inválido.",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        return;
      }

      await updateSession(tenantId, phone, (sess) => {
        sess.portal = sess.portal || {};
        sess.portal.form = sess.portal.form || {};
        sess.portal.form.email = email;
      });

      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.ASK_CEP,
        state: "WZ_CEP",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      return;
    }

    if (ctx === "WZ_CEP") {
      const cep = normalizeCEP(raw);
      if (cep.length !== 8) {
        await sendText({
          tenantId,
          to: phone,
          body: "⚠️ CEP inválido. Envie 8 dígitos.",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        return;
      }

      await updateSession(tenantId, phone, (sess) => {
        sess.portal = sess.portal || {};
        sess.portal.form = sess.portal.form || {};
        sess.portal.form.cep = cep;
      });

      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.ASK_ENDERECO,
        state: "WZ_ENDERECO",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      return;
    }

    if (ctx === "WZ_ENDERECO") {
      const v = normalizeHumanText(raw, 120);

      if (!isValidSimpleAddressField(v, 3, 120)) {
        await sendText({
          tenantId,
          to: phone,
          body: "⚠️ Endereço inválido.",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        return;
      }

      await updateSession(tenantId, phone, (sess) => {
        sess.portal = sess.portal || {};
        sess.portal.form = sess.portal.form || {};
        sess.portal.form.endereco = v;
      });

      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.ASK_NUMERO,
        state: "WZ_NUMERO",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      return;
    }

    if (ctx === "WZ_NUMERO") {
      const v = normalizeHumanText(raw, 20);

      if (!v) {
        await sendText({
          tenantId,
          to: phone,
          body: "⚠️ Informe o número.",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        return;
      }

      await updateSession(tenantId, phone, (sess) => {
        sess.portal = sess.portal || {};
        sess.portal.form = sess.portal.form || {};
        sess.portal.form.numero = v;
      });

      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.ASK_COMPLEMENTO,
        state: "WZ_COMPLEMENTO",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      return;
    }

    if (ctx === "WZ_COMPLEMENTO") {
      const v = normalizeHumanText(raw, 80) || "0";

      await updateSession(tenantId, phone, (sess) => {
        sess.portal = sess.portal || {};
        sess.portal.form = sess.portal.form || {};
        sess.portal.form.complemento = v;
      });

      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.ASK_BAIRRO,
        state: "WZ_BAIRRO",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      return;
    }

    if (ctx === "WZ_BAIRRO") {
      const v = normalizeHumanText(raw, 80);

      if (!isValidSimpleAddressField(v, 2, 80)) {
        await sendText({
          tenantId,
          to: phone,
          body: "⚠️ Informe o bairro.",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        return;
      }

      await updateSession(tenantId, phone, (sess) => {
        sess.portal = sess.portal || {};
        sess.portal.form = sess.portal.form || {};
        sess.portal.form.bairro = v;
      });

      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.ASK_CIDADE,
        state: "WZ_CIDADE",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      return;
    }

    if (ctx === "WZ_CIDADE") {
      const v = normalizeHumanText(raw, 80);

      if (!isValidSimpleAddressField(v, 2, 80)) {
        await sendText({
          tenantId,
          to: phone,
          body: "⚠️ Informe a cidade.",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        return;
      }

      await updateSession(tenantId, phone, (sess) => {
        sess.portal = sess.portal || {};
        sess.portal.form = sess.portal.form || {};
        sess.portal.form.cidade = v;
      });

      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.ASK_UF,
        state: "WZ_UF",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      return;
    }

    if (ctx === "WZ_UF") {
      const uf = cleanStr(raw).toUpperCase();

      if (!/^[A-Z]{2}$/.test(uf)) {
        await sendText({
          tenantId,
          to: phone,
          body: "⚠️ UF inválida. Ex.: SP",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        return;
      }

      await updateSession(tenantId, phone, (sess) => {
        sess.portal = sess.portal || {};
        sess.portal.form = sess.portal.form || {};
        sess.portal.form.uf = uf;
      });

      const sUpdated = await getSession(tenantId, phone);

      const up = await portalAdapter.criarCadastroCompleto({
        form: sUpdated?.portal?.form || {},
        traceMeta: {
          tenantId,
          traceId,
          tracePhone: maskPhone(phone),
          flow: "PORTAL_WIZARD_CREATE",
        },
        runtimeCtx,
      });

      if (!up.ok || !up.codUsuario) {
        await sendText({
          tenantId,
          to: phone,
          body: "⚠️ Não consegui concluir seu cadastro agora. Digite AJUDA para falar com nossa equipe.",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        await setState(tenantId, phone, "MAIN");
        return;
      }

      const prof2 = await patientAdapter.buscarPerfilPaciente({
        codUsuario: up.codUsuario,
        runtimeCtx,
      });

      const v2 = prof2.ok
        ? patientAdapter.validarCadastroCompleto({ perfil: prof2.data })
        : { ok: false, missing: ["dados do cadastro"] };

      if (!v2.ok) {
        await sendText({
          tenantId,
          to: phone,
          body: MSG.PORTAL_NEED_DATA(formatMissing(v2.missing)),
          phoneNumberIdFallback: effectivePhoneNumberId,
        });

        const next = nextWizardStateFromMissing(v2.missing);
        await setState(tenantId, phone, next);

        await sendText({
          tenantId,
          to: phone,
          body: getPromptByWizardState(next),
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        return;
      }

      const sFinal = await getSession(tenantId, phone);
      const planoKeyFinal = sFinal?.portal?.form?.planoKey;

      await clearTransientPortalData(tenantId, phone);

      await finishWizardAndGoToDates({
        schedulingAdapter,
        tenantId,
        tenantConfig,
        phone,
        phoneNumberIdFallback: effectivePhoneNumberId,
        codUsuario: up.codUsuario,
        planoKeyFromWizard: planoKeyFinal,
        traceId,
        codColaborador,
        codPlanoParticular,
        codPlanoMedSeniorSp,
      });

      return;
    }

    await sendAndSetState({
      tenantId,
      phone,
      body: MSG.ASK_CPF_PORTAL,
      state: "WZ_CPF",
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
    return;
  }

  if (ctx === "MAIN") {
    if (digits === "1") {
      return sendAndSetState({
        tenantId,
        phone,
        body: MSG.PARTICULAR,
        state: "PARTICULAR",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
    }

    if (digits === "2") {
      return sendAndSetState({
        tenantId,
        phone,
        body: MSG.CONVENIOS,
        state: "CONVENIOS",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
    }

    if (digits === "3") {
      return sendAndSetState({
        tenantId,
        phone,
        body: MSG.POS_MENU,
        state: "POS",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
    }

    if (digits === "4") {
      return sendAndSetState({
        tenantId,
        phone,
        body: MSG.ATENDENTE,
        state: "ATENDENTE",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
    }

    return sendAndSetState({
      tenantId,
      phone,
      body: MSG.MENU,
      state: "MAIN",
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
  }

  if (ctx === "PARTICULAR") {
    if (digits === "1") {
      await updateSession(tenantId, phone, (s) => {
        s.booking = {
          ...(s.booking || {}),
          planoKey: PLAN_KEYS.PARTICULAR,
          codColaborador,
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
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        consentTextVersion: LGPD_TEXT_VERSION,
        consentTextHash: LGPD_TEXT_HASH,
        timestamp: new Date().toISOString(),
      });

      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.LGPD_CONSENT,
        state: "LGPD_CONSENT",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      return;
    }

    if (digits === "0") {
      return resetToMain(tenantId, phone, effectivePhoneNumberId);
    }

    return sendAndSetState({
      tenantId,
      phone,
      body: MSG.PARTICULAR,
      state: "PARTICULAR",
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
  }

  if (ctx === "CONVENIOS") {
    if (digits === "0") {
      return resetToMain(tenantId, phone, effectivePhoneNumberId);
    }

    if (digits === "1") {
      return sendAndSetState({
        tenantId,
        phone,
        body: MSG.CONVENIO_GOCARE,
        state: "CONV_DETALHE",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
    }

    if (digits === "2") {
      return sendAndSetState({
        tenantId,
        phone,
        body: MSG.CONVENIO_SAMARITANO,
        state: "CONV_DETALHE",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
    }

    if (digits === "3") {
      return sendAndSetState({
        tenantId,
        phone,
        body: MSG.CONVENIO_SALUSMED,
        state: "CONV_DETALHE",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
    }

    if (digits === "4") {
      return sendAndSetState({
        tenantId,
        phone,
        body: MSG.CONVENIO_PROASA,
        state: "CONV_DETALHE",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
    }

    if (digits === "5") {
      await setBookingPlan(tenantId, phone, PLAN_KEYS.MEDSENIOR_SP);
      return sendAndSetState({
        tenantId,
        phone,
        body: MSG.MEDSENIOR,
        state: "MEDSENIOR",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
    }

    return sendAndSetState({
      tenantId,
      phone,
      body: MSG.CONVENIOS,
      state: "CONVENIOS",
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
  }

  if (ctx === "CONV_DETALHE") {
    if (digits === "9") {
      return sendAndSetState({
        tenantId,
        phone,
        body: MSG.PARTICULAR,
        state: "PARTICULAR",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
    }

    if (digits === "0") {
      return resetToMain(tenantId, phone, effectivePhoneNumberId);
    }

    return sendAndSetState({
      tenantId,
      phone,
      body: MSG.CONVENIOS,
      state: "CONVENIOS",
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
  }

  if (ctx === "MEDSENIOR") {
    if (digits === "1") {
      await updateSession(tenantId, phone, (s) => {
        s.booking = {
          ...(s.booking || {}),
          planoKey: PLAN_KEYS.MEDSENIOR_SP,
          codColaborador,
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
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        consentTextVersion: LGPD_TEXT_VERSION,
        consentTextHash: LGPD_TEXT_HASH,
        timestamp: new Date().toISOString(),
      });

      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.LGPD_CONSENT,
        state: "LGPD_CONSENT",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      return;
    }

    if (digits === "0") {
      return resetToMain(tenantId, phone, effectivePhoneNumberId);
    }

    return sendAndSetState({
      tenantId,
      phone,
      body: MSG.MEDSENIOR,
      state: "MEDSENIOR",
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
  }

  if (ctx === "POS") {
    if (digits === "1") {
      return sendAndSetState({
        tenantId,
        phone,
        body: MSG.POS_RECENTE,
        state: "POS_RECENTE",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
    }

    if (digits === "2") {
      return sendAndSetState({
        tenantId,
        phone,
        body: MSG.POS_TARDIO,
        state: "POS_TARDIO",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
    }

    if (digits === "0") {
      return resetToMain(tenantId, phone, effectivePhoneNumberId);
    }

    return sendAndSetState({
      tenantId,
      phone,
      body: MSG.POS_MENU,
      state: "POS",
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
  }

  if (ctx === "POS_RECENTE") {
    if (digits === "0") {
      return resetToMain(tenantId, phone, effectivePhoneNumberId);
    }

    return sendAndSetState({
      tenantId,
      phone,
      body: MSG.POS_RECENTE,
      state: "POS_RECENTE",
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
  }

  if (ctx === "POS_TARDIO") {
    if (digits === "1") {
      return sendAndSetState({
        tenantId,
        phone,
        body: MSG.PARTICULAR,
        state: "PARTICULAR",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
    }

    if (digits === "2") {
      return sendAndSetState({
        tenantId,
        phone,
        body: MSG.CONVENIOS,
        state: "CONVENIOS",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
    }

    if (digits === "0") {
      return resetToMain(tenantId, phone, effectivePhoneNumberId);
    }

    return sendAndSetState({
      tenantId,
      phone,
      body: MSG.POS_TARDIO,
      state: "POS_TARDIO",
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
  }

  if (ctx === "ATENDENTE") {
    if (digits === "0") {
      return resetToMain(tenantId, phone, effectivePhoneNumberId);
    }

    return sendAndSetState({
      tenantId,
      phone,
      body: "Por favor, descreva abaixo como podemos te ajudar.",
      state: "ATENDENTE",
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
  }

  return sendAndSetState({
    tenantId,
    phone,
    body: MSG.MENU,
    state: "MAIN",
    phoneNumberIdFallback: effectivePhoneNumberId,
  });
}

export { handleInbound };

async function failSafeTenantConfigError({
  tenantId,
  phone,
  phoneNumberIdFallback,
}) {
  try {
    await sendText({
      tenantId,
      to: phone,
      body:
        "⚠️ Não foi possível continuar seu atendimento automático neste momento. Por favor, tente novamente em instantes.",
      phoneNumberIdFallback,
    });
  } catch {}
}

async function clearTransientPortalData(tenantId, phone) {
  await updateSession(tenantId, phone, (s) => {
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

function bookingConfirmKey(tenantId, phone, codHorario) {
  const t = String(tenantId || "").trim();
  const p = String(phone || "").replace(/\D+/g, "");
  return `booking:confirm:${t}:${p}:${codHorario}`;
}

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

function makeWaLink(supportWa, prefillText) {
  const wa = String(supportWa || "").replace(/\D+/g, "");
  const encoded = encodeURIComponent(prefillText);
  return `https://wa.me/${wa}?text=${encoded}`;
}

async function sendSupportLink({
  tenantId,
  phone,
  phoneNumberIdFallback,
  prefill,
  supportWa,
  nextState = "MAIN",
}) {
  const link = makeWaLink(supportWa, prefill);

  await sendText({
    tenantId,
    to: phone,
    body: `✅ Para falar com nossa equipe, clique no link abaixo e envie a mensagem:\n\n${link}`,
    phoneNumberIdFallback,
  });

  if (nextState) {
    await setState(tenantId, phone, nextState);
  }
}

function buildSupportPrefillFromSession(
  phone,
  s,
  traceId = null,
  tenantId = null
) {
  const faltas = Array.isArray(s?.portal?.missing) ? s.portal.missing : [];
  const issue = s?.portal?.issue || null;

  const motivo =
    issue?.type === "CONVENIO_NAO_HABILITADO"
      ? "Convênio desejado não habilitado no cadastro."
      : "Ajuda no agendamento.";

  return buildSafeSupportPrefill({
    tenantId,
    traceId,
    phone,
    reason: motivo,
    missing: faltas,
  });
}

function buildSafeSupportPrefill({
  tenantId = null,
  traceId = null,
  phone = "",
  reason = "",
  details = "",
  missing = [],
}) {
  const lines = [
    "Olá! Preciso de ajuda no agendamento.",
    "",
    `Tenant: ${tenantId || "(não informado)"}`,
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

async function fetchSlotsDoDia({
  schedulingAdapter,
  tenantId,
  tenantConfig,
  traceId = null,
  codColaborador,
  codUsuario,
  isoDate,
  phone = "",
}) {
  const out = await schedulingAdapter.buscarSlotsDoDia({
    tenantId,
    tenantConfig,
    traceId,
    codColaborador,
    codUsuario,
    isoDate,
    tracePhone: maskPhone(phone),
  });

  if (!out?.ok || !Array.isArray(out?.slots)) {
    return { ok: false, slots: [] };
  }

  const slots = out.slots.filter(
    (x) =>
      x &&
      Number(x.codHorario) &&
      typeof x.hhmm === "string" &&
      isSlotAllowed(isoDate, x.hhmm)
  );

  return { ok: true, slots };
}

async function fetchNextAvailableDates({
  schedulingAdapter,
  tenantId,
  tenantConfig,
  traceId = null,
  codColaborador,
  codUsuario,
  phone = "",
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

    const out = await fetchSlotsDoDia({
      schedulingAdapter,
      tenantId,
      tenantConfig,
      traceId,
      codColaborador,
      codUsuario,
      isoDate,
      phone,
    });

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
  schedulingAdapter,
  tenantId,
  tenantConfig,
  phone,
  phoneNumberIdFallback,
  codColaborador,
  codUsuario,
  traceId = null,
}) {
  const dates = await fetchNextAvailableDates({
    schedulingAdapter,
    tenantId,
    tenantConfig,
    traceId,
    codColaborador,
    codUsuario,
    phone,
    daysLookahead: 60,
    limit: 3,
  });

  if (!dates.length) {
    await sendText({
      tenantId,
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
    tenantId,
    to: phone,
    body: "Escolha uma data:",
    buttons,
    phoneNumberIdFallback,
  });

  return true;
}

async function showSlotsPage({
  tenantId,
  phone,
  phoneNumberIdFallback,
  slots,
  page = 0,
}) {
  const pageSize = 3;
  const start = page * pageSize;
  const end = start + pageSize;

  const pageItems = slots.slice(start, end);

  if (!pageItems.length) {
    await sendText({
      tenantId,
      to: phone,
      body: "⚠️ Não há horários disponíveis (considerando o mínimo de 12h).",
      phoneNumberIdFallback,
    });

    await sendButtons({
      tenantId,
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
    tenantId,
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
    tenantId,
    to: phone,
    body: "Opções:",
    buttons: extraButtons,
    phoneNumberIdFallback,
  });
}

async function sendAndSetState({
  tenantId,
  phone,
  body,
  state,
  phoneNumberIdFallback,
}) {
  const sent = await sendText({
    tenantId,
    to: phone,
    body,
    phoneNumberIdFallback,
  });

  if (!sent) return false;

  if (state) {
    await setState(tenantId, phone, state);
  }

  return true;
}

async function resetToMain(tenantId, phone, phoneNumberIdFallback) {
  await updateSession(tenantId, phone, (s) => {
    if (s?.portal) {
      s.portal.form = {};
      delete s.portal.issue;
      delete s.portal.missing;
    }
    if (s?.pending) delete s.pending;
  });

  await sendAndSetState({
    tenantId,
    phone,
    body: MSG.MENU,
    state: "MAIN",
    phoneNumberIdFallback,
  });
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
  schedulingAdapter,
  tenantId,
  tenantConfig,
  phone,
  phoneNumberIdFallback,
  codUsuario,
  planoKeyFromWizard,
  traceId = null,
  codColaborador,
  codPlanoParticular,
  codPlanoMedSeniorSp,
}) {
  const isRetorno = await schedulingAdapter.verificarRetorno30Dias({
    codUsuario,
    runtimeCtx: {
      tenantId,
      tenantConfig,
      traceId,
      tracePhone: maskPhone(phone),
      codPlanoParticular,
      codPlanoMedSeniorSp,
    },
  });

  await updateSession(tenantId, phone, (s) => {
    s.booking = s.booking || {};
    s.booking.codUsuario = codUsuario;
    s.booking.codColaborador = codColaborador;
    s.booking.isRetorno = isRetorno;

    if (planoKeyFromWizard) {
      s.booking.planoKey = planoKeyFromWizard;
    }
  });

  const shown = await showNextDates({
    schedulingAdapter,
    tenantId,
    tenantConfig,
    phone,
    phoneNumberIdFallback,
    codColaborador,
    codUsuario,
    traceId,
  });

  if (shown) {
    await setState(tenantId, phone, "ASK_DATE_PICK");
  }
}

function resolvePlanCodeFromRuntime(planKey, runtime) {
  if (planKey === PLAN_KEYS.MEDSENIOR_SP) {
    return Number(runtime?.codPlanoMedSeniorSp || 0) || null;
  }

  return Number(runtime?.codPlanoParticular || 0) || null;
}
