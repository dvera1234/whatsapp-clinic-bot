import crypto from "crypto";

import {
  configureInactivityHandler,
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
  PLAN_KEYS,
  FLOW_RESET_CODE,
  MIN_LEAD_HOURS,
  TZ_OFFSET,
  LGPD_TEXT_VERSION,
  LGPD_TEXT_HASH,
} from "../config/constants.js";

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

async function handleInbound({
  context = {},
  phone,
  text: inboundText,
  phoneNumberIdFallback,
}) {
  const traceId = String(context?.traceId || crypto.randomUUID());
  const tenantId = String(context?.tenantId || "").trim();
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

  const runtime = resolveRuntimeFromContext(context);

  if (!runtime) {
    audit("RUNTIME_MISSING_BLOCKED", {
      tenantId,
      traceId,
      tracePhone: maskPhone(phone),
      blockedBeforeFlow: true,
    });

    await failSafeTenantConfigError({
      tenantId,
      phone,
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
    return;
  }

  let MSG;
  try {
    MSG = getFlowText(runtime);
  } catch (err) {
    audit("TENANT_CONTENT_INVALID", {
      tenantId,
      traceId,
      tracePhone: maskPhone(phone),
      error: String(err?.message || err),
      blockedBeforeFlow: true,
    });

    await failSafeTenantConfigError({
      tenantId,
      phone,
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
    return;
  }

  configureInactivityHandler({
    sendText,
    getMessage: () =>
      runtime?.content?.messages?.inactivityClosureMessage ||
      "Sessão encerrada por inatividade.",
  });

  let patientAdapter;
  let portalAdapter;
  let schedulingAdapter;

  try {
    patientAdapter = createPatientAdapter({ tenantId, runtime });
    portalAdapter = createPortalAdapter({ tenantId, runtime });
    schedulingAdapter = createSchedulingAdapter({ tenantId, runtime });
  } catch (err) {
    audit("TENANT_PROVIDER_FACTORY_INIT_FAILED", {
      tenantId,
      traceId,
      tracePhone: maskPhone(phone),
      error: String(err?.message || err),
      blockedBeforeFlow: true,
    });

    await failSafeTenantConfigError({
      tenantId,
      phone,
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
    return;
  }

  const { practitionerId } = getClinicIdsFromRuntime(runtime);
  const portalUrl = runtime?.portal?.url || "";
  const supportWa = runtime?.support?.waNumber || "";

  const runtimeCtx = {
    tenantId,
    runtime,
    traceId,
    tracePhone: maskPhone(phone),
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
      MSG,
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
      MSG,
    });

    await clearTransientPortalData(tenantId, phone);
    return;
  }

  if (ctx === "PLAN_PICK") {
    if (upper !== "PLAN_USE_PRIVATE" && upper !== "PLAN_USE_INSURED") {
      await sendText({
        tenantId,
        to: phone,
        body: MSG.BUTTONS_ONLY_WARNING,
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      return;
    }

    const chosenKey =
      upper === "PLAN_USE_INSURED" ? PLAN_KEYS.INSURED : PLAN_KEYS.PRIVATE;

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
        body: MSG.BOOKING_SESSION_INVALID,
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      await setState(tenantId, phone, "MAIN");
      return;
    }

    await finishWizardAndGoToDates({
      schedulingAdapter,
      tenantId,
      runtime,
      phone,
      phoneNumberIdFallback: effectivePhoneNumberId,
      patientId,
      planKeyFromWizard: chosenKey,
      traceId,
      practitionerId,
      MSG,
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
        body: MSG.BOOKING_SESSION_INVALID,
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      await setState(tenantId, phone, "MAIN");
      return;
    }

    const out = await findSlotsByDate({
      schedulingAdapter,
      runtimeCtx,
      practitionerId: selectedPractitionerId,
      patientId,
      appointmentDate,
      phone,
    });

    if (out.providerUnavailable) {
      await handleProviderTemporaryUnavailable({
        tenantId,
        traceId,
        phone,
        phoneNumberIdFallback: effectivePhoneNumberId,
        capability: "booking",
        err: out.error,
        MSG,
        nextState: "MAIN",
      });
      return;
    }

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
      MSG,
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
        body: MSG.BOOKING_SESSION_INVALID,
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      await setState(tenantId, phone, "MAIN");
      return;
    }

    const shown = await showNextDates({
      schedulingAdapter,
      runtimeCtx,
      phone,
      phoneNumberIdFallback: effectivePhoneNumberId,
      practitionerId: selectedPractitionerId,
      patientId,
      MSG,
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
        MSG,
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
          body: MSG.BOOKING_SESSION_INVALID,
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        await setState(tenantId, phone, "MAIN");
        return;
      }

      const shown = await showNextDates({
        schedulingAdapter,
        runtimeCtx,
        phone,
        phoneNumberIdFallback: effectivePhoneNumberId,
        practitionerId: selectedPractitionerId,
        patientId,
        MSG,
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
          body: MSG.BOOKING_SLOT_INVALID,
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
        body: MSG.BOOKING_SLOT_CONFIRM,
        buttons: [
          { id: "CONFIRMAR", title: MSG.ACTION_CONFIRM },
          { id: "ESCOLHER_OUTRO", title: MSG.ACTION_PICK_OTHER },
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
        MSG,
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
        MSG,
      });
      return;
    }

    if (upper === "CONFIRMAR") {
      const s = await getSession(tenantId, phone);
      const slotId = Number(s?.pending?.slotId);

      const bookingRequest = {
        slotId,
        patientId: s?.booking?.patientId,
        providerId: s?.booking?.practitionerId ?? practitionerId,
        planKey: s?.booking?.planKey || PLAN_KEYS.PRIVATE,
        isTelemedicine: false,
      };

      if (!bookingRequest.patientId) {
        await sendText({
          tenantId,
          to: phone,
          body: MSG.BOOKING_PATIENT_NOT_IDENTIFIED,
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
          body: MSG.BOOKING_SLOT_NOT_FOUND,
          phoneNumberIdFallback: effectivePhoneNumberId,
        });

        await showSlotsPage({
          tenantId,
          phone,
          phoneNumberIdFallback: effectivePhoneNumberId,
          slots,
          page: 0,
          MSG,
        });
        return;
      }

      const bookingKey = bookingConfirmKey(tenantId, phone, slotId);
      const lockOk = await redis.set(bookingKey, "1", { ex: 60, nx: true });

      if (!lockOk) {
        await sendText({
          tenantId,
          to: phone,
          body: MSG.BOOKING_ALREADY_PROCESSING,
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        return;
      }

      try {
        const appointmentDate = s?.booking?.appointmentDate;
        const chosen = (s?.booking?.slots || []).find(
          (x) => Number(x.slotId) === slotId
        );

        if (
          !appointmentDate ||
          !chosen?.time ||
          !isSlotAllowed(appointmentDate, chosen.time)
        ) {
          await updateSession(tenantId, phone, (sess) => {
            delete sess.pending;
          });

          await setState(tenantId, phone, "SLOTS");
          await sendText({
            tenantId,
            to: phone,
            body: MSG.BOOKING_SLOT_TOO_SOON,
            phoneNumberIdFallback: effectivePhoneNumberId,
          });

          const selectedPractitionerId =
            s?.booking?.practitionerId ?? practitionerId;
          const patientId = s?.booking?.patientId;

          if (!patientId) {
            await sendText({
              tenantId,
              to: phone,
              body: MSG.BOOKING_SESSION_INVALID,
              phoneNumberIdFallback: effectivePhoneNumberId,
            });
            await setState(tenantId, phone, "MAIN");
            return;
          }

          const outSlots = await findSlotsByDate({
            schedulingAdapter,
            runtimeCtx,
            practitionerId: selectedPractitionerId,
            patientId,
            appointmentDate,
            phone,
          });

          if (outSlots.providerUnavailable) {
            await handleProviderTemporaryUnavailable({
              tenantId,
              traceId,
              phone,
              phoneNumberIdFallback: effectivePhoneNumberId,
              capability: "booking",
              err: outSlots.error,
              MSG,
              nextState: "MAIN",
            });
            return;
          }

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
            MSG,
          });
          return;
        }

        let out;
        try {
          out = await schedulingAdapter.confirmBooking({
            bookingRequest,
            runtimeCtx,
          });
        } catch (err) {
          if (isProviderTemporaryUnavailableError(err)) {
            await updateSession(tenantId, phone, (sess) => {
              delete sess.pending;
            });

            await handleProviderTemporaryUnavailable({
              tenantId,
              traceId,
              phone,
              phoneNumberIdFallback: effectivePhoneNumberId,
              capability: "booking",
              err,
              MSG,
              nextState: "MAIN",
            });
            return;
          }
          throw err;
        }

        audit(
          "BOOKING_CONFIRM_FLOW",
          sanitizeForLog({
            tenantId,
            traceId,
            tracePhone: maskPhone(phone),
            patientId: bookingRequest.patientId || null,
            slotId: bookingRequest.slotId || null,
            planKey: bookingRequest.planKey || null,
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
            body: MSG.BOOKING_CONFIRM_FAILURE,
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
            MSG,
          });
          return;
        }

        const msgOk =
          out?.data?.providerResult?.Message ||
          out?.data?.providerResult?.message ||
          out?.data?.Message ||
          out?.data?.message ||
          "Agendamento confirmado com sucesso!";

        const isPrivateBooking =
          (s?.booking?.planKey || PLAN_KEYS.PRIVATE) === PLAN_KEYS.PRIVATE;
        const isReturnBooking = !!s?.booking?.isReturn;
        const showPaymentInfo = isPrivateBooking && !isReturnBooking;

        const paymentInfo = showPaymentInfo
          ? MSG.PAYMENT_INFO_PRIVATE_FIRST_VISIT
          : "";

        try {
          await setState(tenantId, phone, "MAIN");

          const sentMainSuccess = await sendText({
            tenantId,
            to: phone,
            body: tpl(MSG.BOOKING_SUCCESS_MAIN, {
              msgOk,
              paymentInfo,
            }),
            phoneNumberIdFallback: effectivePhoneNumberId,
          });

          let sentPortalLink = false;
          if (portalUrl) {
            sentPortalLink = await sendText({
              tenantId,
              to: phone,
              body: tpl(MSG.PORTAL_LINK_PREFIX, { portalUrl }),
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
          audit(
            "BOOKING_POST_CONFIRM_COMMUNICATION_FAILURE",
            sanitizeForLog({
              tenantId,
              traceId,
              tracePhone: maskPhone(phone),
              rid: out?.rid || null,
              httpStatus: out?.status || null,
              technicalAccepted: true,
              functionalResult:
                "BOOKING_CREATED_BUT_COMMUNICATION_PARTIAL_FAILURE",
              patientFacingMessage: "BOOKING_SUCCESS_FALLBACK_MESSAGE",
              escalationRequired: false,
            })
          );

          await sendText({
            tenantId,
            to: phone,
            body: MSG.BOOKING_SUCCESS_FALLBACK,
            phoneNumberIdFallback: effectivePhoneNumberId,
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
      body: MSG.BUTTONS_ONLY_WARNING,
      buttons: [
        { id: "CONFIRMAR", title: MSG.ACTION_CONFIRM },
        { id: "ESCOLHER_OUTRO", title: MSG.ACTION_PICK_OTHER },
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
      MSG,
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
        MSG,
      });

      await clearTransientPortalData(tenantId, phone);
      return;
    }

    await resetToMain(tenantId, phone, effectivePhoneNumberId, MSG);
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

      let patientIdResult;
      try {
        patientIdResult = await patientAdapter.findPatientIdByDocument({
          document,
          runtimeCtx,
        });
      } catch (err) {
        if (isProviderTemporaryUnavailableError(err)) {
          await handleProviderTemporaryUnavailable({
            tenantId,
            traceId,
            phone,
            phoneNumberIdFallback: effectivePhoneNumberId,
            capability: "identity",
            err,
            MSG,
            nextState: "MAIN",
          });
          return;
        }
        throw err;
      }

      const patientId =
        patientIdResult?.ok && Number(patientIdResult?.data?.patientId) > 0
          ? Number(patientIdResult.data.patientId)
          : null;

      debugLog(
        "PATIENT_DOCUMENT_IDENTIFICATION_RESULT",
        sanitizeForLog({
          tenantId,
          traceId,
          tracePhone: maskPhone(phone),
          documentMasked: "***",
          patientIdFound: !!patientId,
          patientId: patientId || null,
          httpStatus: patientIdResult?.status || null,
          rid: patientIdResult?.rid || null,
        })
      );

      if (!patientId) {
        await updateSession(tenantId, phone, (s2) => {
          s2.portal = s2.portal || {};
          s2.portal.exists = false;
          s2.portal.form = s2.portal.form || {};
          s2.portal.form.document = document;
        });

        await sendText({
          tenantId,
          to: phone,
          body: MSG.WIZARD_NEW_PATIENT_NAME,
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

      let profileResult;
      try {
        profileResult = await patientAdapter.getPatientProfile({
          patientId,
          runtimeCtx,
        });
      } catch (err) {
        if (isProviderTemporaryUnavailableError(err)) {
          await handleProviderTemporaryUnavailable({
            tenantId,
            traceId,
            phone,
            phoneNumberIdFallback: effectivePhoneNumberId,
            capability: "identity",
            err,
            MSG,
            nextState: "MAIN",
          });
          return;
        }
        throw err;
      }

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
          body: MSG.PROFILE_LOOKUP_FAILURE,
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        await setState(tenantId, phone, "MAIN");
        return;
      }

      const validationResult = patientAdapter.validateRegistrationData({
        profile: profileResult.data,
      });

      const validation =
        validationResult?.ok && validationResult?.data
          ? validationResult.data
          : { ok: false, missing: ["dados do cadastro"] };

      if (validation.ok) {
        const sCurrent = await getSession(tenantId, phone);
        const flowPlanKey = sCurrent?.booking?.planKey || PLAN_KEYS.PRIVATE;

        const planIdsResult = patientAdapter.listActivePlans({
          profile: profileResult.data,
        });

        const planIds =
          planIdsResult?.ok && Array.isArray(planIdsResult?.data)
            ? planIdsResult.data
            : [];

        const hasPrivatePlan = hasPlanKey({
          planIds,
          runtime,
          planKey: PLAN_KEYS.PRIVATE,
        });

        const hasInsuredPlan = hasPlanKey({
          planIds,
          runtime,
          planKey: PLAN_KEYS.INSURED,
        });

        await updateSession(tenantId, phone, (sess) => {
          sess.booking = sess.booking || {};
          sess.booking.patientId = patientId;
        });

        if (
          hasPrivatePlan &&
          !hasInsuredPlan &&
          flowPlanKey === PLAN_KEYS.PRIVATE
        ) {
          await finishWizardAndGoToDates({
            schedulingAdapter,
            tenantId,
            runtime,
            phone,
            phoneNumberIdFallback: effectivePhoneNumberId,
            patientId,
            planKeyFromWizard: flowPlanKey,
            traceId,
            practitionerId,
            MSG,
          });
          return;
        }

        if (
          !hasPrivatePlan &&
          hasInsuredPlan &&
          flowPlanKey === PLAN_KEYS.INSURED
        ) {
          await finishWizardAndGoToDates({
            schedulingAdapter,
            tenantId,
            runtime,
            phone,
            phoneNumberIdFallback: effectivePhoneNumberId,
            patientId,
            planKeyFromWizard: flowPlanKey,
            traceId,
            practitionerId,
            MSG,
          });
          return;
        }

        if (
          hasPrivatePlan &&
          !hasInsuredPlan &&
          flowPlanKey === PLAN_KEYS.INSURED
        ) {
          await updateSession(tenantId, phone, (sess) => {
            sess.portal = sess.portal || {};
            sess.portal.issue = {
              type: "PLAN_NOT_ENABLED",
              wantedPlan: PLAN_KEYS.INSURED,
              note: "Paciente possui apenas plano privado ativo no cadastro.",
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
            body: MSG.PLAN_NOT_ENABLED_MESSAGE,
            buttons: [
              { id: "PLAN_USE_PRIVATE", title: MSG.BTN_PLAN_PRIVATE },
              { id: "FALAR_ATENDENTE", title: MSG.BTN_FALAR_ATENDENTE },
            ],
            phoneNumberIdFallback: effectivePhoneNumberId,
          });

          await setState(tenantId, phone, "PLAN_PICK");
          return;
        }

        if (
          !hasPrivatePlan &&
          hasInsuredPlan &&
          flowPlanKey === PLAN_KEYS.PRIVATE
        ) {
          await sendButtons({
            tenantId,
            to: phone,
            body: MSG.PLAN_DIVERGENCIA,
            buttons: [
              { id: "PLAN_USE_PRIVATE", title: MSG.BTN_PLAN_PRIVATE },
              { id: "PLAN_USE_INSURED", title: MSG.BTN_PLAN_INSURED },
            ],
            phoneNumberIdFallback: effectivePhoneNumberId,
          });

          await setState(tenantId, phone, "PLAN_PICK");
          return;
        }

        audit(
          "PLAN_VALIDATION_DEBUG",
          sanitizeForLog({
            tenantId,
            traceId,
            tracePhone: maskPhone(phone),
            patientId: Number(patientId) || null,
            flowPlanKey,
            planIdsDetected: Array.isArray(planIds) ? planIds.map(Number) : [],
            hasPrivatePlan,
            hasInsuredPlan,
            validationResult: "PLAN_VALIDATION_FAILURE_BRANCH",
          })
        );

        await sendText({
          tenantId,
          to: phone,
          body: MSG.PLAN_VALIDATION_FAILURE,
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
          missingFields: Array.isArray(validation.missing)
            ? validation.missing
            : [],
          escalationRequired: true,
        })
      );

      await sendButtons({
        tenantId,
        to: phone,
        body: tpl(MSG.PORTAL_EXISTENTE_INCOMPLETO_BLOQUEIO, {
          faltas: formatMissing(validation.missing),
        }),
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
          body: MSG.NAME_INVALID,
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
          body: MSG.DATE_INVALID,
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
        body: MSG.SEX_PROMPT,
        buttons: [
          { id: "SX_M", title: MSG.SEX_MALE },
          { id: "SX_F", title: MSG.SEX_FEMALE },
          { id: "SX_NI", title: MSG.SEX_NO_INFO },
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
        body: MSG.PLAN_SELECTION_PROMPT,
        buttons: [
          { id: "PLAN_PRIVATE", title: MSG.PLAN_OPTION_PRIVATE },
          { id: "PLAN_INSURED", title: MSG.PLAN_OPTION_INSURED },
        ],
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
      await setState(tenantId, phone, "WZ_PLANO");
      return;
    }

    if (ctx === "WZ_PLANO") {
      if (upper !== "PLAN_PRIVATE" && upper !== "PLAN_INSURED") {
        await sendText({
          tenantId,
          to: phone,
          body: MSG.PICK_PLAN_BUTTONS_ONLY,
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        return;
      }

      await updateSession(tenantId, phone, (sess) => {
        sess.portal = sess.portal || {};
        sess.portal.form = sess.portal.form || {};
        sess.portal.form.planKey =
          upper === "PLAN_INSURED" ? PLAN_KEYS.INSURED : PLAN_KEYS.PRIVATE;
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
          body: MSG.EMAIL_INVALID,
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
          body: MSG.CEP_INVALID,
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
          body: MSG.ADDRESS_INVALID,
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
          body: MSG.ADDRESS_NUMBER_INVALID,
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
          body: MSG.DISTRICT_INVALID,
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
          body: MSG.CITY_INVALID,
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
          body: MSG.UF_INVALID,
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

      let registrationResult;
      try {
        registrationResult = await portalAdapter.createPatientRegistration({
          registrationData: sUpdated?.portal?.form || {},
          traceMeta: {
            tenantId,
            traceId,
            tracePhone: maskPhone(phone),
            flow: "PATIENT_REGISTRATION_WIZARD_CREATE",
          },
          runtimeCtx,
        });
      } catch (err) {
        if (isProviderTemporaryUnavailableError(err)) {
          await handleProviderTemporaryUnavailable({
            tenantId,
            traceId,
            phone,
            phoneNumberIdFallback: effectivePhoneNumberId,
            capability: "access",
            err,
            MSG,
            nextState: "MAIN",
          });
          return;
        }
        throw err;
      }

      const registeredPatientId =
        registrationResult?.ok &&
        Number(registrationResult?.data?.patientId) > 0
          ? Number(registrationResult.data.patientId)
          : null;

      if (!registrationResult.ok || !registeredPatientId) {
        await sendText({
          tenantId,
          to: phone,
          body: MSG.REGISTRATION_CREATE_FAILURE,
          phoneNumberIdFallback: effectivePhoneNumberId,
        });
        await setState(tenantId, phone, "MAIN");
        return;
      }

      let profileResult2;
      try {
        profileResult2 = await patientAdapter.getPatientProfile({
          patientId: registeredPatientId,
          runtimeCtx,
        });
      } catch (err) {
        if (isProviderTemporaryUnavailableError(err)) {
          await handleProviderTemporaryUnavailable({
            tenantId,
            traceId,
            phone,
            phoneNumberIdFallback: effectivePhoneNumberId,
            capability: "identity",
            err,
            MSG,
            nextState: "MAIN",
          });
          return;
        }
        throw err;
      }

      const validation2Result = profileResult2.ok
        ? patientAdapter.validateRegistrationData({
            profile: profileResult2.data,
          })
        : null;

      const validation2 =
        validation2Result?.ok && validation2Result?.data
          ? validation2Result.data
          : { ok: false, missing: ["dados do cadastro"] };

      if (!validation2.ok) {
        await sendText({
          tenantId,
          to: phone,
          body: tpl(MSG.PORTAL_NEED_DATA, {
            faltas: formatMissing(validation2.missing),
          }),
          phoneNumberIdFallback: effectivePhoneNumberId,
        });

        const next = nextWizardStateFromMissing(validation2.missing);
        await setState(tenantId, phone, next);

        await sendText({
          tenantId,
          to: phone,
          body: getPromptByWizardState(next, MSG),
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
        runtime,
        phone,
        phoneNumberIdFallback: effectivePhoneNumberId,
        patientId: registeredPatientId,
        planKeyFromWizard: finalPlanKey,
        traceId,
        practitionerId,
        MSG,
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
        body: MSG.PRIVATE_MENU,
        state: "PRIVATE_MENU",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
    }

    if (digits === "2") {
      return sendAndSetState({
        tenantId,
        phone,
        body: MSG.INSURANCE_MENU,
        state: "INSURANCE_MENU",
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

  if (ctx === "PRIVATE_MENU") {
    if (digits === "1") {
      await updateSession(tenantId, phone, (s) => {
        s.booking = {
          ...(s.booking || {}),
          planKey: PLAN_KEYS.PRIVATE,
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
      return resetToMain(tenantId, phone, effectivePhoneNumberId, MSG);
    }

    return sendAndSetState({
      tenantId,
      phone,
      body: MSG.PRIVATE_MENU,
      state: "PRIVATE_MENU",
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
  }

  if (ctx === "INSURANCE_MENU") {
    if (digits === "0") {
      return resetToMain(tenantId, phone, effectivePhoneNumberId, MSG);
    }

    if (digits === "1") {
      return sendAndSetState({
        tenantId,
        phone,
        body: MSG.INSURANCE_INFO_1,
        state: "INSURANCE_INFO",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
    }

    if (digits === "2") {
      return sendAndSetState({
        tenantId,
        phone,
        body: MSG.INSURANCE_INFO_2,
        state: "INSURANCE_INFO",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
    }

    if (digits === "3") {
      return sendAndSetState({
        tenantId,
        phone,
        body: MSG.INSURANCE_INFO_3,
        state: "INSURANCE_INFO",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
    }

    if (digits === "4") {
      return sendAndSetState({
        tenantId,
        phone,
        body: MSG.INSURANCE_INFO_4,
        state: "INSURANCE_INFO",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
    }

    if (digits === "5") {
      await setBookingPlan(tenantId, phone, PLAN_KEYS.INSURED);
      return sendAndSetState({
        tenantId,
        phone,
        body: MSG.INSURED_DIRECT_MENU,
        state: "INSURED_DIRECT",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
    }

    return sendAndSetState({
      tenantId,
      phone,
      body: MSG.INSURANCE_MENU,
      state: "INSURANCE_MENU",
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
  }

  if (ctx === "INSURANCE_INFO") {
    if (digits === "9") {
      return sendAndSetState({
        tenantId,
        phone,
        body: MSG.PRIVATE_MENU,
        state: "PRIVATE_MENU",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
    }

    if (digits === "0") {
      return resetToMain(tenantId, phone, effectivePhoneNumberId, MSG);
    }

    return sendAndSetState({
      tenantId,
      phone,
      body: MSG.INSURANCE_MENU,
      state: "INSURANCE_MENU",
      phoneNumberIdFallback: effectivePhoneNumberId,
    });
  }

  if (ctx === "INSURED_DIRECT") {
    if (digits === "1") {
      await updateSession(tenantId, phone, (s) => {
        s.booking = {
          ...(s.booking || {}),
          planKey: PLAN_KEYS.INSURED,
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
      return resetToMain(tenantId, phone, effectivePhoneNumberId, MSG);
    }

    return sendAndSetState({
      tenantId,
      phone,
      body: MSG.INSURED_DIRECT_MENU,
      state: "INSURED_DIRECT",
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
      return resetToMain(tenantId, phone, effectivePhoneNumberId, MSG);
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
      return resetToMain(tenantId, phone, effectivePhoneNumberId, MSG);
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
        body: MSG.PRIVATE_MENU,
        state: "PRIVATE_MENU",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
    }

    if (digits === "2") {
      return sendAndSetState({
        tenantId,
        phone,
        body: MSG.INSURANCE_MENU,
        state: "INSURANCE_MENU",
        phoneNumberIdFallback: effectivePhoneNumberId,
      });
    }

    if (digits === "0") {
      return resetToMain(tenantId, phone, effectivePhoneNumberId, MSG);
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
      return resetToMain(tenantId, phone, effectivePhoneNumberId, MSG);
    }

    return sendAndSetState({
      tenantId,
      phone,
      body: MSG.ATTENDANT_DESCRIBE,
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

function resolveRuntimeFromContext(context = {}) {
  const runtime =
    context?.runtime ||
    context?.tenantRuntime ||
    context?.resolvedRuntime ||
    null;

  if (!runtime || typeof runtime !== "object") {
    return null;
  }

  return runtime;
}

function getClinicIdsFromRuntime(runtime = {}) {
  return {
    practitionerId: runtime?.clinic?.providerId ?? null,
  };
}

function getPlanIdsFromRuntime(runtime = {}) {
  return {
    privatePlanId: Number(runtime?.plans?.privatePlanId) || null,
    insuredPlanId: Number(runtime?.plans?.insuredPlanId) || null,
  };
}

function hasPlanKey({ planIds, runtime, planKey }) {
  const { privatePlanId, insuredPlanId } = getPlanIdsFromRuntime(runtime);

  const normalizedPlanIds = Array.isArray(planIds)
    ? planIds.map((x) => Number(x)).filter(Number.isFinite)
    : [];

  if (planKey === PLAN_KEYS.PRIVATE) {
    return privatePlanId != null && normalizedPlanIds.includes(privatePlanId);
  }

  if (planKey === PLAN_KEYS.INSURED) {
    return insuredPlanId != null && normalizedPlanIds.includes(insuredPlanId);
  }

  return false;
}

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

function getPromptByWizardState(state, MSG) {
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
  MSG,
}) {
  const link = makeWaLink(supportWa, prefill);

  await sendText({
    tenantId,
    to: phone,
    body: tpl(MSG.SUPPORT_LINK_MESSAGE, { link }),
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
      ? "Plano desejado não habilitado no cadastro."
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

function isProviderTemporaryUnavailableError(err) {
  if (!err) return false;

  if (err?.code === "PROVIDER_CIRCUIT_OPEN") return true;

  const msg = String(err?.message || err).toLowerCase();

  return (
    msg.includes("provider temporarily unavailable") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("504")
  );
}

async function handleProviderTemporaryUnavailable({
  tenantId,
  traceId = null,
  phone,
  phoneNumberIdFallback,
  capability = null,
  err,
  MSG,
  nextState = "MAIN",
}) {
  audit("PROVIDER_TEMPORARILY_UNAVAILABLE", {
    tenantId,
    traceId,
    tracePhone: maskPhone(phone),
    capability,
    errorCode: err?.code || null,
    error: String(err?.message || err || "unknown_error"),
    patientMessageSent: true,
  });

  await sendText({
    tenantId,
    to: phone,
    body: MSG.PROVIDER_UNAVAILABLE,
    phoneNumberIdFallback,
  });

  if (nextState) {
    await setState(tenantId, phone, nextState);
  }
}

async function findSlotsByDate({
  schedulingAdapter,
  runtimeCtx,
  practitionerId,
  patientId,
  appointmentDate,
  phone = "",
}) {
  let out;

  try {
    out = await schedulingAdapter.findSlotsByDate({
      providerId: practitionerId,
      patientId,
      isoDate: appointmentDate,
      runtimeCtx: {
        ...runtimeCtx,
        tracePhone: maskPhone(phone),
      },
    });
  } catch (err) {
    if (isProviderTemporaryUnavailableError(err)) {
      return {
        ok: false,
        slots: [],
        providerUnavailable: true,
        error: err,
      };
    }
    throw err;
  }

  if (!out?.ok || !Array.isArray(out?.data?.slots)) {
    return {
      ok: false,
      slots: [],
      providerUnavailable: false,
      error: null,
    };
  }

  const slots = out.data.slots.filter(
    (x) =>
      x &&
      Number(x.slotId) &&
      typeof x.time === "string" &&
      isSlotAllowed(appointmentDate, x.time)
  );

  return {
    ok: true,
    slots,
    providerUnavailable: false,
    error: null,
  };
}

async function fetchNextAvailableDates({
  schedulingAdapter,
  runtimeCtx,
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
      runtimeCtx,
      practitionerId,
      patientId,
      appointmentDate,
      phone,
    });

    if (out.providerUnavailable) {
      return {
        ok: false,
        dates: [],
        providerUnavailable: true,
        error: out.error,
      };
    }

    if (out.ok && out.slots.length > 0) {
      dates.push(appointmentDate);
    }
  }

  return {
    ok: true,
    dates,
    providerUnavailable: false,
    error: null,
  };
}

function formatBRFromISO(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ""));
  if (!m) return isoDate;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

async function showNextDates({
  schedulingAdapter,
  runtimeCtx,
  phone,
  phoneNumberIdFallback,
  practitionerId,
  patientId,
  MSG,
}) {
  const result = await fetchNextAvailableDates({
    schedulingAdapter,
    runtimeCtx,
    practitionerId,
    patientId,
    phone,
    daysLookahead: 60,
    limit: 3,
  });

  if (result.providerUnavailable) {
    await handleProviderTemporaryUnavailable({
      tenantId: runtimeCtx?.tenantId,
      traceId: runtimeCtx?.traceId || null,
      phone,
      phoneNumberIdFallback,
      capability: "booking",
      err: result.error,
      MSG,
      nextState: "MAIN",
    });
    return false;
  }

  const dates = result.dates || [];

  if (!dates.length) {
    await sendText({
      tenantId: runtimeCtx?.tenantId,
      to: phone,
      body: MSG.BOOKING_NO_DATES,
      phoneNumberIdFallback,
    });
    return false;
  }

  const buttons = dates.map((iso) => ({
    id: `D_${iso}`,
    title: formatBRFromISO(iso),
  }));

  await sendButtons({
    tenantId: runtimeCtx?.tenantId,
    to: phone,
    body: MSG.BOOKING_PICK_DATE,
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
  MSG,
}) {
  const pageSize = 3;
  const start = page * pageSize;
  const end = start + pageSize;

  const pageItems = slots.slice(start, end);

  if (!pageItems.length) {
    await sendText({
      tenantId,
      to: phone,
      body: MSG.BOOKING_NO_SLOTS,
      phoneNumberIdFallback,
    });

    await sendButtons({
      tenantId,
      to: phone,
      body: MSG.BOOKING_CHANGE_DATE,
      buttons: [{ id: "TROCAR_DATA", title: MSG.BOOKING_CHANGE_DATE }],
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
    body: MSG.BOOKING_AVAILABLE_SLOTS,
    buttons,
    phoneNumberIdFallback,
  });

  const extraButtons = [];

  if (end < slots.length) {
    extraButtons.push({ id: `PAGE_${page + 1}`, title: MSG.BOOKING_VIEW_MORE });
  }
  extraButtons.push({ id: "TROCAR_DATA", title: MSG.BOOKING_CHANGE_DATE });

  await sendButtons({
    tenantId,
    to: phone,
    body: MSG.BOOKING_OPTIONS,
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

async function resetToMain(tenantId, phone, phoneNumberIdFallback, MSG) {
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

function requireText(messages, key) {
  const value = messages?.[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`TENANT_CONTENT_MISSING:${key}`);
  }
  return value;
}

function optionalText(messages, key, fallback) {
  const value = messages?.[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

function getFlowText(runtime) {
  const messages = runtime?.content?.messages || {};

  return {
    ASK_CPF_PORTAL: requireText(messages, "askCpfPortal"),
    CPF_INVALIDO: requireText(messages, "cpfInvalido"),
    PLAN_DIVERGENCIA: requireText(messages, "planDivergencia"),
    BTN_PLAN_PRIVATE: requireText(messages, "btnPlanPrivate"),
    BTN_PLAN_INSURED: requireText(messages, "btnPlanInsured"),
    BTN_FALAR_ATENDENTE: requireText(messages, "btnFalarAtendente"),

    PORTAL_NEED_DATA: requireText(messages, "portalNeedData"),
    PORTAL_EXISTENTE_INCOMPLETO_BLOQUEIO: requireText(
      messages,
      "portalExistenteIncompletoBloqueio"
    ),

    ASK_NOME: requireText(messages, "askNome"),
    ASK_DTNASC: requireText(messages, "askDtNasc"),
    ASK_EMAIL: requireText(messages, "askEmail"),
    ASK_CEP: requireText(messages, "askCep"),
    ASK_ENDERECO: requireText(messages, "askEndereco"),
    ASK_NUMERO: requireText(messages, "askNumero"),
    ASK_COMPLEMENTO: requireText(messages, "askComplemento"),
    ASK_BAIRRO: requireText(messages, "askBairro"),
    ASK_CIDADE: requireText(messages, "askCidade"),
    ASK_UF: requireText(messages, "askUf"),

    MENU: requireText(messages, "menu"),
    LGPD_CONSENT: requireText(messages, "lgpdConsent"),
    LGPD_RECUSA: requireText(messages, "lgpdRecusa"),

    PRIVATE_MENU: requireText(messages, "privateMenu"),
    INSURANCE_MENU: requireText(messages, "insuranceMenu"),
    INSURANCE_INFO_1: requireText(messages, "insuranceInfo1"),
    INSURANCE_INFO_2: requireText(messages, "insuranceInfo2"),
    INSURANCE_INFO_3: requireText(messages, "insuranceInfo3"),
    INSURANCE_INFO_4: requireText(messages, "insuranceInfo4"),
    INSURED_DIRECT_MENU: requireText(messages, "insuredDirectMenu"),

    POS_MENU: requireText(messages, "posMenu"),
    POS_RECENTE: requireText(messages, "posRecente"),
    POS_TARDIO: requireText(messages, "posTardio"),
    ATENDENTE: requireText(messages, "atendente"),
    AJUDA_PERGUNTA: requireText(messages, "ajudaPergunta"),
    REDIS_UNAVAILABLE: optionalText(
      messages,
      "redisUnavailable",
      "⚠️ Não foi possível continuar o atendimento agora. Por favor, tente novamente em instantes."
    ),
    PROVIDER_UNAVAILABLE: optionalText(
      messages,
      "providerUnavailable",
      "⚠️ Nosso sistema está temporariamente indisponível no momento. Por favor, tente novamente em instantes."
    ),

    BUTTONS_ONLY_WARNING: requireText(messages, "buttonsOnlyWarning"),
    PICK_PLAN_BUTTONS_ONLY: requireText(messages, "pickPlanButtonsOnly"),

    BOOKING_SESSION_INVALID: requireText(messages, "bookingSessionInvalid"),
    BOOKING_SLOT_CONFIRM: requireText(messages, "bookingSlotConfirm"),
    BOOKING_SLOT_INVALID: requireText(messages, "bookingSlotInvalid"),
    BOOKING_PATIENT_NOT_IDENTIFIED: requireText(
      messages,
      "bookingPatientNotIdentified"
    ),
    BOOKING_ALREADY_PROCESSING: requireText(
      messages,
      "bookingAlreadyProcessing"
    ),
    BOOKING_SLOT_NOT_FOUND: requireText(messages, "bookingSlotNotFound"),
    BOOKING_SLOT_TOO_SOON: requireText(messages, "bookingSlotTooSoon"),
    BOOKING_CONFIRM_FAILURE: requireText(messages, "bookingConfirmFailure"),
    BOOKING_SUCCESS_FALLBACK: requireText(messages, "bookingSuccessFallback"),
    BOOKING_NO_DATES: requireText(messages, "bookingNoDates"),
    BOOKING_PICK_DATE: requireText(messages, "bookingPickDate"),
    BOOKING_NO_SLOTS: requireText(messages, "bookingNoSlots"),
    BOOKING_CHANGE_DATE: requireText(messages, "bookingChangeDate"),
    BOOKING_AVAILABLE_SLOTS: requireText(messages, "bookingAvailableSlots"),
    BOOKING_OPTIONS: requireText(messages, "bookingOptions"),
    BOOKING_VIEW_MORE: requireText(messages, "bookingViewMore"),

    WIZARD_NEW_PATIENT_NAME: requireText(messages, "wizardNewPatientName"),
    PROFILE_LOOKUP_FAILURE: requireText(messages, "profileLookupFailure"),
    PLAN_VALIDATION_FAILURE: requireText(messages, "planValidationFailure"),
    NAME_INVALID: requireText(messages, "nameInvalid"),
    DATE_INVALID: requireText(messages, "dateInvalid"),
    EMAIL_INVALID: requireText(messages, "emailInvalid"),
    CEP_INVALID: requireText(messages, "cepInvalid"),
    ADDRESS_INVALID: requireText(messages, "addressInvalid"),
    ADDRESS_NUMBER_INVALID: requireText(messages, "addressNumberInvalid"),
    DISTRICT_INVALID: requireText(messages, "districtInvalid"),
    CITY_INVALID: requireText(messages, "cityInvalid"),
    UF_INVALID: requireText(messages, "ufInvalid"),
    REGISTRATION_CREATE_FAILURE: requireText(
      messages,
      "registrationCreateFailure"
    ),

    ATTENDANT_DESCRIBE: requireText(messages, "attendantDescribe"),
    SUPPORT_LINK_MESSAGE: requireText(messages, "supportLinkMessage"),
    PLAN_NOT_ENABLED_MESSAGE: requireText(messages, "planNotEnabledMessage"),

    BOOKING_SUCCESS_MAIN: requireText(messages, "bookingSuccessMain"),
    PORTAL_LINK_PREFIX: requireText(messages, "portalLinkPrefix"),
    PAYMENT_INFO_PRIVATE_FIRST_VISIT: requireText(
      messages,
      "paymentInfoPrivateFirstVisit"
    ),

    SEX_PROMPT: requireText(messages, "sexPrompt"),
    SEX_MALE: requireText(messages, "sexMale"),
    SEX_FEMALE: requireText(messages, "sexFemale"),
    SEX_NO_INFO: requireText(messages, "sexNoInfo"),

    PLAN_SELECTION_PROMPT: requireText(messages, "planSelectionPrompt"),
    PLAN_OPTION_PRIVATE: requireText(messages, "planOptionPrivate"),
    PLAN_OPTION_INSURED: requireText(messages, "planOptionInsured"),

    ACTION_CONFIRM: requireText(messages, "actionConfirm"),
    ACTION_PICK_OTHER: requireText(messages, "actionPickOther"),
  };
}

function tpl(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => {
    const value = vars[key];
    return value == null ? "" : String(value);
  });
}

async function finishWizardAndGoToDates({
  schedulingAdapter,
  tenantId,
  runtime,
  phone,
  phoneNumberIdFallback,
  patientId,
  planKeyFromWizard,
  traceId = null,
  practitionerId,
  MSG,
}) {
  let eligibilityResult;

  try {
    eligibilityResult = await schedulingAdapter.checkReturnEligibility({
      patientId,
      runtimeCtx: {
        tenantId,
        runtime,
        traceId,
        tracePhone: maskPhone(phone),
      },
    });
  } catch (err) {
    if (isProviderTemporaryUnavailableError(err)) {
      await handleProviderTemporaryUnavailable({
        tenantId,
        traceId,
        phone,
        phoneNumberIdFallback,
        capability: "booking",
        err,
        MSG,
        nextState: "MAIN",
      });
      return false;
    }
    throw err;
  }

  const isReturn =
    !!eligibilityResult?.ok && eligibilityResult?.data?.eligible === true;

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
    runtimeCtx: {
      tenantId,
      runtime,
      traceId,
      tracePhone: maskPhone(phone),
    },
    phone,
    phoneNumberIdFallback,
    practitionerId,
    patientId,
    MSG,
  });

  if (shown) {
    await setState(tenantId, phone, "ASK_DATE_PICK");
  }

  return shown;
}
