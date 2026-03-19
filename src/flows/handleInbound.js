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

import { sanitizeForLog } from "../utils/logSanitizer.js";
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

  const practitionerId = runtime?.clinic?.primaryPractitionerId ?? null;
  const unitId = runtime?.clinic?.defaultUnitId ?? null;
  const specialtyId = runtime?.clinic?.defaultSpecialtyId ?? null;

  const privatePlanId = runtime?.plans?.privatePlanId ?? null;
  const insuredPlanId = runtime?.plans?.insuredPlanId ?? null;

  const portalUrl = runtime?.portal?.url || "";
  const supportWa = runtime?.support?.waNumber || "";

  const runtimeCtx = {
    tenantId,
    tenantConfig,
    tenantRuntime: runtime,
    traceId,
    tracePhone: maskPhone(phone),
    privatePlanId,
    insuredPlanId,
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

  debugLog(
    "FLOW_INBOUND_RECEIVED",
    sanitizeForLog({
      tenantId,
      traceId,
      phoneMasked: maskPhone(phone),
      state: currentState,
      inboundKind: digits ? "digits-or-button" : "text",
    })
  );

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
    const missing = Array.isArray(s?.portal?.missing) ? s.portal.missing : [];

    const prefill = buildSafeSupportPrefill({
      tenantId,
      traceId,
      phone,
      reason: "Cadastro incompleto no Portal do Paciente.",
      missing,
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
      sess.booking.planKey = chosenKey;

      if (sess.portal?.issue) {
        delete sess.portal.issue;
      }
    });

    const s = await getSession(tenantId, phone);
    const patientId = Number(s?.booking?.patientId || s?.portal?.patientId);

    if (!patientId) {
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
      patientId,
      planKeyFromWizard: chosenKey,
      traceId,
      practitionerId,
      privatePlanId,
      insuredPlanId,
    });

    return;
  }

  if (upper.startsWith("D_")) {
    const appointmentDate = raw.slice(2).trim();
    const s = await getSession(tenantId, phone);

    const selectedPractitionerId =
      s?.booking?.practitionerId ?? practitionerId;
    const patientId = s?.booking?.patientId;

    if (!patientId) {
      await sendText({
        tenantId,
        to: phone,
        body: "⚠️ Sessão inválida. Digite 1 para iniciar novamente.",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      await setState(tenantId, phone, "MAIN");
      return;
    }

    const out = await findSlotsByDate({
      schedulingAdapter,
      tenantId,
      tenantConfig,
      traceId,
      practitionerId: selectedPractitionerId,
      patientId,
      appointmentDate,
      phone,
    });

    const slots = out.ok ? out.slots : [];

    await updateSession(tenantId, phone, (sess) => {
      sess.booking = {
        ...(sess.booking || {}),
        practitionerId: selectedPractitionerId,
        patientId,
        appointmentDate,
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
    const selectedPractitionerId =
      s?.booking?.practitionerId ?? practitionerId;
    const patientId = s?.booking?.patientId;

    if (!patientId) {
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
      practitionerId: selectedPractitionerId,
      patientId,
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
      const selectedPractitionerId =
        s?.booking?.practitionerId ?? practitionerId;
      const patientId = s?.booking?.patientId;

      await updateSession(tenantId, phone, (sess) => {
        if (sess?.booking) {
          sess.booking.appointmentDate = null;
          sess.booking.slots = [];
          sess.booking.pageIndex = 0;
        }
      });

      if (!patientId) {
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
        practitionerId: selectedPractitionerId,
        patientId,
        traceId,
      });

      if (shown) {
        await setState(tenantId, phone, "ASK_DATE_PICK");
      }
      return;
    }

    if (upper.startsWith("H_")) {
      const slotId = Number(raw.split("_")[1]);
      if (!slotId || Number.isNaN(slotId)) {
        await sendText({
          tenantId,
          to: phone,
          body: "⚠️ Horário inválido.",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        return;
      }

      await updateSession(tenantId, phone, (s) => {
        s.pending = { slotId };
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
      const slotId = Number(s?.pending?.slotId);
      const selectedPlanId = resolvePlanIdFromRuntime(
        s?.booking?.planKey || PLAN_KEYS.PARTICULAR,
        {
          privatePlanId,
          insuredPlanId,
        }
      );

      const bookingRequest = {
        unitId,
        specialtyId,
        planId: selectedPlanId,
        slotId,
        patientId: s?.booking?.patientId,
        providerId: s?.booking?.practitionerId ?? practitionerId,
        isTelemedicine: false,
        shouldConfirm: true,
      };

      if (!bookingRequest.patientId) {
        await sendText({
          tenantId,
          to: phone,
          body: "⚠️ Não consegui identificar o paciente. Digite AJUDA.",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        await setState(tenantId, phone, "MAIN");
        return;
      }

      if (!slotId || Number.isNaN(slotId)) {
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

      const bookingKey = bookingConfirmKey(tenantId, phone, slotId);
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
        const appointmentDate = s?.booking?.appointmentDate;
        const chosen = (s?.booking?.slots || []).find(
          (x) => Number(x.slotId) === slotId
        );

        if (!appointmentDate || !chosen?.time || !isSlotAllowed(appointmentDate, chosen.time)) {
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

          const selectedPractitionerId =
            s?.booking?.practitionerId ?? practitionerId;
          const patientId = s?.booking?.patientId;

          if (!patientId) {
            await sendText({
              tenantId,
              to: phone,
              body: "⚠️ Sessão inválida. Digite 1 para iniciar novamente.",
              phoneNumberIdFallback: effectivePhoneNumberId,
            });
            await setState(tenantId, phone, "MAIN");
            return;
          }

          const outSlots = await findSlotsByDate({
            schedulingAdapter,
            tenantId,
            tenantConfig,
            traceId,
            practitionerId: selectedPractitionerId,
            patientId,
            appointmentDate,
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

        const out = await schedulingAdapter.confirmBooking({
          tenantId,
          tenantConfig,
          bookingRequest,
          traceMeta: {
            tenantId,
            traceId,
            flow: "CONFIRM_BOOKING",
            tracePhone: maskPhone(phone),
            patientId: bookingRequest.patientId || null,
            slotId: bookingRequest.slotId || null,
            planId: bookingRequest.planId || null,
            providerId: bookingRequest.providerId || null,
          },
        });

        audit(
          "BOOKING_CONFIRM_FLOW",
          sanitizeForLog({
            tenantId,
            traceId,
            tracePhone: maskPhone(phone),
            patientId: bookingRequest.patientId || null,
            slotId: bookingRequest.slotId || null,
            planId: bookingRequest.planId || null,
            providerId: bookingRequest.providerId || null,
            appointmentDate: s?.booking?.appointmentDate || null,
            appointmentTime: chosen?.time || null,
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
          })
        );

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

          audit(
            "BOOKING_CONFIRM_PATIENT_RESPONSE",
            sanitizeForLog({
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
            })
          );

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

        const isPrivateBooking =
          Number(bookingRequest.planId) === Number(privatePlanId);
        const isReturnBooking = !!s?.booking?.isReturn;
        const showPaymentInfo = isPrivateBooking && !isReturnBooking;

        const PAYMENT_INFO = showPaymentInfo
          ? `

💳 *Pagamento da consulta*
Após realizar o check-in no totem, efetue o pagamento antes do atendimento.`
          : "";

        const GUIDANCE = `⏰ *Chegada*
Recomendamos que chegue com 15 minutos de antecedência.

🛋️ *Conforto*
Nossa sala de espera foi pensada com carinho para seu conforto: ambiente acolhedor, água disponível, Wi-Fi gratuito e honest market com opções variadas.

🚗 *Estacionamento*
Há estacionamento com valet no prédio.

📍 *Ao chegar*
Leve um documento oficial com foto para realizar seu cadastro na recepção do edifício e dirija-se ao 6º andar. Ao chegar, identifique-se no totem de atendimento.${PAYMENT_INFO}`;

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
            body: `✅ ${msgOk}\n\n${GUIDANCE}\n\n${PORTAL_INFO}`,
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

          audit(
          "BOOKING_CONFIRM_PATIENT_RESPONSE",
          sanitizeForLog({
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
          })
        );
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

          audit(
            "BOOKING_POST_CONFIRM_COMMUNICATION_FAILURE",
            sanitizeForLog({
              tenantId,
              traceId,
              tracePhone: maskPhone(phone),
              rid: out?.rid || null,
              httpStatus: out?.status || null,
              technicalAccepted: true,
              functionalResult: "BOOKING_CREATED_BUT_COMMUNICATION_PARTIAL_FAILURE",
              patientFacingMessage: "BOOKING_SUCCESS_FALLBACK_MESSAGE",
              escalationRequired: false,
            })
          );
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
        sess.portal = { patientId: null, exists: false, form: {} };
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
      const document = onlyCpfDigits(raw);

      if (!document) {
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
        cpfMasked: maskCpf(document),
        consentTextVersion: LGPD_TEXT_VERSION,
        consentTextHash: LGPD_TEXT_HASH,
        timestamp: new Date().toISOString(),
      });

      debugLog(
        "PATIENT_DOCUMENT_RECEIVED_FOR_IDENTIFICATION",
        sanitizeForLog({
          tenantId,
          traceId,
          tracePhone: maskPhone(phone),
          documentMasked: "***",
        })
      );

      const patientId = await patientAdapter.findPatientIdByDocument({
        document,
        runtimeCtx,
      });

      debugLog(
        "PATIENT_DOCUMENT_IDENTIFICATION_RESULT",
        sanitizeForLog({
          tenantId,
          traceId,
          tracePhone: maskPhone(phone),
          documentMasked: "***",
          patientIdFound: !!patientId,
          patientId: patientId || null,
        })
      );

      if (!patientId) {
        await updateSession(tenantId, phone, (s) => {
          s.portal = s.portal || {};
          s.portal.exists = false;
          s.portal.form = s.portal.form || {};
          s.portal.form.document = document;
        });

        await sendText({
          tenantId,
          to: phone,
          body: "Perfeito! Vamos fazer seu cadastro 😊\n\nDigite seu nome completo:",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });

        await setState(tenantId, phone, "WZ_NOME");
        return;
      }

      await updateSession(tenantId, phone, (sess) => {
        sess.portal = sess.portal || {};
        sess.portal.form = sess.portal.form || {};
        sess.portal.form.document = document;
        sess.portal.exists = true;
        sess.portal.patientId = patientId;
      });

      const profileResult = await patientAdapter.getPatientProfile({
        patientId,
        runtimeCtx,
      });

      if (profileResult.ok && profileResult.data) {
        const profile = profileResult.data;

        await updateSession(tenantId, phone, (sess) => {
          sess.portal = sess.portal || {};
          sess.portal.form = sess.portal.form || {};

          const fullName = cleanStr(profile?.Nome);
          if (fullName && !sess.portal.form.fullName) {
            sess.portal.form.fullName = fullName;
          }

          const email = cleanStr(profile?.Email);
          if (isValidEmail(email) && !sess.portal.form.email) {
            sess.portal.form.email = email;
          }

          const mobilePhone = cleanStr(profile?.Celular).replace(/\D+/g, "");
          if (mobilePhone.length >= 10 && !sess.portal.form.mobilePhone) {
            sess.portal.form.mobilePhone = mobilePhone;
          }

          const phoneNumber = cleanStr(profile?.Telefone).replace(/\D+/g, "");
          if (phoneNumber.length >= 10 && !sess.portal.form.phone) {
            sess.portal.form.phone = phoneNumber;
          }

          const postalCode = String(profile?.CEP ?? "").replace(/\D+/g, "");
          if (postalCode.length === 8 && !sess.portal.form.postalCode) {
            sess.portal.form.postalCode = postalCode;
          }

          const streetAddress = cleanStr(profile?.Endereco);
          if (streetAddress && !sess.portal.form.streetAddress) {
            sess.portal.form.streetAddress = streetAddress;
          }

          const addressNumber = cleanStr(profile?.Numero);
          if (addressNumber && !sess.portal.form.addressNumber) {
            sess.portal.form.addressNumber = addressNumber;
          }

          const addressComplement = cleanStr(profile?.Complemento);
          if (addressComplement && !sess.portal.form.addressComplement) {
            sess.portal.form.addressComplement = addressComplement;
          }

          const district = cleanStr(profile?.Bairro);
          if (district && !sess.portal.form.district) {
            sess.portal.form.district = district;
          }

          const city = cleanStr(profile?.Cidade);
          if (city && !sess.portal.form.city) {
            sess.portal.form.city = city;
          }

          const birthDateRaw = cleanStr(profile?.DtNasc);
          let birthDateISO = parseBRDateToISO(birthDateRaw) || null;

          if (!birthDateISO) {
            const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(birthDateRaw);
            if (m) birthDateISO = `${m[1]}-${m[2]}-${m[3]}`;
          }

          if (birthDateISO && !sess.portal.form.birthDateISO) {
            sess.portal.form.birthDateISO = birthDateISO;
          }
        });
      }

      if (!profileResult.ok || !profileResult.data) {
        await sendText({
          tenantId,
          to: phone,
          body: "⚠️ Encontrei seu cadastro, mas não consegui consultar seus dados agora. Por favor, fale com nossa equipe.",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        await setState(tenantId, phone, "MAIN");
        return;
      }

      const validation = patientAdapter.validateRegistrationData({
        profile: profileResult.data,
      });

      if (validation.ok) {
        const sCurrent = await getSession(tenantId, phone);
        const flowPlanKey = sCurrent?.booking?.planKey || PLAN_KEYS.PARTICULAR;
        const planIds = patientAdapter.listActivePlans({
          profile: profileResult.data,
        });

        const hasPrivatePlan = patientAdapter.hasPlan({
          planIds,
          planKey: PLAN_KEYS.PARTICULAR,
          runtimeCtx,
        });

        const hasInsuredPlan = patientAdapter.hasPlan({
          planIds,
          planKey: PLAN_KEYS.MEDSENIOR_SP,
          runtimeCtx,
        });

        await updateSession(tenantId, phone, (sess) => {
          sess.booking = sess.booking || {};
          sess.booking.patientId = patientId;
        });

        if (hasPrivatePlan && !hasInsuredPlan && flowPlanKey === PLAN_KEYS.PARTICULAR) {
          await finishWizardAndGoToDates({
            schedulingAdapter,
            tenantId,
            tenantConfig,
            phone,
            phoneNumberIdFallback: effectivePhoneNumberId,
            patientId,
            planKeyFromWizard: flowPlanKey,
            traceId,
            practitionerId,
            privatePlanId,
            insuredPlanId,
          });
          return;
        }

        if (!hasPrivatePlan && hasInsuredPlan && flowPlanKey === PLAN_KEYS.MEDSENIOR_SP) {
          await finishWizardAndGoToDates({
            schedulingAdapter,
            tenantId,
            tenantConfig,
            phone,
            phoneNumberIdFallback: effectivePhoneNumberId,
            patientId,
            planKeyFromWizard: flowPlanKey,
            traceId,
            practitionerId,
            privatePlanId,
            insuredPlanId,
          });
          return;
        }

        if (hasPrivatePlan && !hasInsuredPlan && flowPlanKey === PLAN_KEYS.MEDSENIOR_SP) {
          await updateSession(tenantId, phone, (sess) => {
            sess.portal = sess.portal || {};
            sess.portal.issue = {
              type: "PLAN_NOT_ENABLED",
              wantedPlan: "MEDSENIOR_SP",
              note: "Paciente possui apenas plano particular ativo no cadastro.",
              patientId: Number(patientId) || null,
              planIdsDetected: Array.isArray(planIds)
                ? planIds.map(Number)
                : [],
            };
          });

          audit(
            "PLAN_INCONSISTENCY_INSURED_PLAN_NOT_ENABLED",
            sanitizeForLog({
              tenantId,
              traceId,
              tracePhone: maskPhone(phone),
              patientId: Number(patientId) || null,
              flowPlanKey,
              planIdsDetected: Array.isArray(planIds)
                ? planIds.map(Number)
                : [],
              escalationRequired: true,
            })
          );

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

        if (!hasPrivatePlan && hasInsuredPlan && flowPlanKey === PLAN_KEYS.PARTICULAR) {
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
        sess.portal.missing = validation.missing;
      });

      audit(
        "EXISTING_PATIENT_BLOCKED_INCOMPLETE_REGISTRATION",
        sanitizeForLog({
          tenantId,
          traceId,
          tracePhone: maskPhone(phone),
          patientId: patientId || null,
          missingFields: Array.isArray(validation.missing) ? validation.missing : [],
          escalationRequired: true,
        })
      );

      await sendButtons({
        tenantId,
        to: phone,
        body: MSG.PORTAL_EXISTENTE_INCOMPLETO_BLOQUEIO(
          formatMissing(validation.missing)
        ),
        buttons: [{ id: "FALAR_ATENDENTE", title: MSG.BTN_FALAR_ATENDENTE }],
        phoneNumberIdFallback: effectivePhoneNumberId,
      });

      await setState(tenantId, phone, "BLOCK_EXISTING_INCOMPLETE");
      return;
    }

    if (ctx === "WZ_NOME") {
      const fullName = normalizeHumanText(raw, 120);

      if (!isValidName(fullName)) {
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
        sess.portal.form.fullName = fullName;
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
      const birthDateISO = parseBRDateToISO(raw);
      if (!birthDateISO) {
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
        sess.portal.form.birthDateISO = birthDateISO;
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

        if (upper === "SX_M") sess.portal.form.gender = "M";
        else if (upper === "SX_F") sess.portal.form.gender = "F";
        else sess.portal.form.gender = "NI";
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
        sess.portal.form.planKey =
          upper === "PL_MED" ? PLAN_KEYS.MEDSENIOR_SP : PLAN_KEYS.PARTICULAR;
        sess.portal.form.mobilePhone = formatPhoneFromWA(phone);
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
      const postalCode = normalizeCEP(raw);
      if (postalCode.length !== 8) {
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
        sess.portal.form.postalCode = postalCode;
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
      const streetAddress = normalizeHumanText(raw, 120);

      if (!isValidSimpleAddressField(streetAddress, 3, 120)) {
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
        sess.portal.form.streetAddress = streetAddress;
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
      const addressNumber = normalizeHumanText(raw, 20);

      if (!addressNumber) {
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
        sess.portal.form.addressNumber = addressNumber;
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
      const addressComplement = normalizeHumanText(raw, 80) || "0";

      await updateSession(tenantId, phone, (sess) => {
        sess.portal = sess.portal || {};
        sess.portal.form = sess.portal.form || {};
        sess.portal.form.addressComplement = addressComplement;
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
      const district = normalizeHumanText(raw, 80);

      if (!isValidSimpleAddressField(district, 2, 80)) {
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
        sess.portal.form.district = district;
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
      const city = normalizeHumanText(raw, 80);

      if (!isValidSimpleAddressField(city, 2, 80)) {
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
        sess.portal.form.city = city;
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
      const stateCode = cleanStr(raw).toUpperCase();

      if (!/^[A-Z]{2}$/.test(stateCode)) {
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
        sess.portal.form.stateCode = stateCode;
      });

      const sUpdated = await getSession(tenantId, phone);

      const registrationResult = await portalAdapter.createPatientRegistration({
        registrationData: sUpdated?.portal?.form || {},
        traceMeta: {
          tenantId,
          traceId,
          tracePhone: maskPhone(phone),
          flow: "PATIENT_REGISTRATION_WIZARD_CREATE",
        },
        runtimeCtx,
      });

      if (!registrationResult.ok || !registrationResult.patientId) {
        await sendText({
          tenantId,
          to: phone,
          body: "⚠️ Não consegui concluir seu cadastro agora. Digite AJUDA para falar com nossa equipe.",
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        await setState(tenantId, phone, "MAIN");
        return;
      }

      const profileResult2 = await patientAdapter.getPatientProfile({
        patientId: registrationResult.patientId,
        runtimeCtx,
      });

      const validation2 = profileResult2.ok
        ? patientAdapter.validateRegistrationData({ profile: profileResult2.data })
        : { ok: false, missing: ["dados do cadastro"] };

      if (!validation2.ok) {
        await sendText({
          tenantId,
          to: phone,
          body: MSG.PORTAL_NEED_DATA(formatMissing(validation2.missing)),
          phoneNumberIdFallback: effectivePhoneNumberId,
        });

        const next = nextWizardStateFromMissing(validation2.missing);
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
      const finalPlanKey = sFinal?.portal?.form?.planKey;

      await clearTransientPortalData(tenantId, phone);

      await finishWizardAndGoToDates({
        schedulingAdapter,
        tenantId,
        tenantConfig,
        phone,
        phoneNumberIdFallback: effectivePhoneNumberId,
        patientId: registrationResult.patientId,
        planKeyFromWizard: finalPlanKey,
        traceId,
        practitionerId,
        privatePlanId,
        insuredPlanId,
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
          planKey: PLAN_KEYS.PARTICULAR,
          practitionerId,
          patientId: null,
          appointmentDate: null,
          slots: [],
          pageIndex: 0,
          isReturn: false,
        };

        s.portal = {
          step: "CPF",
          patientId: null,
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
          planKey: PLAN_KEYS.MEDSENIOR_SP,
          practitionerId,
          patientId: null,
          appointmentDate: null,
          slots: [],
          pageIndex: 0,
          isReturn: false,
        };

        s.portal = {
          step: "CPF",
          patientId: null,
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

function bookingConfirmKey(tenantId, phone, slotId) {
  const t = String(tenantId || "").trim();
  const p = String(phone || "").replace(/\D+/g, "");
  return `booking:confirm:${t}:${p}:${slotId}`;
}

function formatMissing(list) {
  return list.map((x) => `• ${x}`).join("\n");
}

function formatPhoneFromWA(phone) {
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
  const missing = Array.isArray(s?.portal?.missing) ? s.portal.missing : [];
  const issue = s?.portal?.issue || null;

  const reason =
    issue?.type === "PLAN_NOT_ENABLED"
      ? "Convênio desejado não habilitado no cadastro."
      : "Ajuda no agendamento.";

  return buildSafeSupportPrefill({
    tenantId,
    traceId,
    phone,
    reason,
    missing,
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

function slotEpochMs(appointmentDate, appointmentTime) {
  const d = new Date(`${appointmentDate}T${appointmentTime}:00${TZ_OFFSET}`);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

function isSlotAllowed(appointmentDate, appointmentTime) {
  const ms = slotEpochMs(appointmentDate, appointmentTime);
  if (!Number.isFinite(ms)) return false;
  const minMs = Date.now() + MIN_LEAD_HOURS * 60 * 60 * 1000;
  return ms >= minMs;
}

async function findSlotsByDate({
  schedulingAdapter,
  tenantId,
  tenantConfig,
  traceId = null,
  practitionerId,
  patientId,
  appointmentDate,
  phone = "",
}) {
  const out = await schedulingAdapter.findSlotsByDate({
    tenantId,
    tenantConfig,
    traceId,
    providerId: practitionerId,
    patientId,
    isoDate: appointmentDate,
    tracePhone: maskPhone(phone),
  });

  if (!out?.ok || !Array.isArray(out?.slots)) {
    return { ok: false, slots: [] };
  }

  const slots = out.slots.filter(
    (x) =>
      x &&
      Number(x.slotId) &&
      typeof x.time === "string" &&
      isSlotAllowed(appointmentDate, x.time)
  );

  return { ok: true, slots };
}

async function fetchNextAvailableDates({
  schedulingAdapter,
  tenantId,
  tenantConfig,
  traceId = null,
  practitionerId,
  patientId,
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

    const appointmentDate = `${d.getFullYear()}-${String(
      d.getMonth() + 1
    ).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    const out = await findSlotsByDate({
      schedulingAdapter,
      tenantId,
      tenantConfig,
      traceId,
      practitionerId,
      patientId,
      appointmentDate,
      phone,
    });

    if (out.ok && out.slots.length > 0) {
      dates.push(appointmentDate);
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
  practitionerId,
  patientId,
  traceId = null,
}) {
  const dates = await fetchNextAvailableDates({
    schedulingAdapter,
    tenantId,
    tenantConfig,
    traceId,
    practitionerId,
    patientId,
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
    id: `H_${x.slotId}`,
    title: x.time,
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
  if (m.has("estado (UF)")) return "WZ_UF";

  return "WZ_NOME";
}

async function finishWizardAndGoToDates({
  schedulingAdapter,
  tenantId,
  tenantConfig,
  phone,
  phoneNumberIdFallback,
  patientId,
  planKeyFromWizard,
  traceId = null,
  practitionerId,
  privatePlanId,
  insuredPlanId,
}) {
  const isReturn = await schedulingAdapter.checkReturnEligibility({
    patientId,
    runtimeCtx: {
      tenantId,
      tenantConfig,
      traceId,
      tracePhone: maskPhone(phone),
      privatePlanId,
      insuredPlanId,
    },
  });

  await updateSession(tenantId, phone, (s) => {
    s.booking = s.booking || {};
    s.booking.patientId = patientId;
    s.booking.practitionerId = practitionerId;
    s.booking.isReturn = isReturn;

    if (planKeyFromWizard) {
      s.booking.planKey = planKeyFromWizard;
    }
  });

  const shown = await showNextDates({
    schedulingAdapter,
    tenantId,
    tenantConfig,
    phone,
    phoneNumberIdFallback,
    practitionerId,
    patientId,
    traceId,
  });

  if (shown) {
    await setState(tenantId, phone, "ASK_DATE_PICK");
  }
}

function resolvePlanIdFromRuntime(planKey, runtime) {
  if (planKey === PLAN_KEYS.MEDSENIOR_SP) {
    return Number(runtime?.insuredPlanId || 0) || null;
  }

  return Number(runtime?.privatePlanId || 0) || null;
}
