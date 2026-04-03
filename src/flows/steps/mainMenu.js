import { updateSession } from "../../session/redisSession.js";
import {
  PLAN_KEYS,
  LGPD_TEXT_VERSION,
  LGPD_TEXT_HASH,
} from "../../config/constants.js";
import { audit } from "../../observability/audit.js";
import { maskPhone } from "../../utils/mask.js";
import { resetToMain, sendAndSetState } from "../helpers/flowHelpers.js";

function getTenantMessages(runtime) {
  return runtime?.content?.messages || {};
}

function getInsuranceOptions(runtime, MSG) {
  const tenantMessages = getTenantMessages(runtime);

  const runtimeOptions = Array.isArray(tenantMessages.insuranceOptions)
    ? tenantMessages.insuranceOptions
    : [];

  if (runtimeOptions.length > 0) {
    return runtimeOptions
      .map((item) => ({
        id: String(item?.id || "").trim(),
        label: String(item?.label || "").trim(),
        actionType: String(item?.actionType || "").trim(),
        messageKey: String(item?.messageKey || "").trim() || null,
      }))
      .filter((item) => item.id && item.label && item.actionType);
  }

  const msgOptions = Array.isArray(MSG?.INSURANCE_OPTIONS)
    ? MSG.INSURANCE_OPTIONS
    : [];

  return msgOptions
    .map((item) => ({
      id: String(item?.id || "").trim(),
      label: String(item?.label || "").trim(),
      actionType: String(item?.actionType || "").trim(),
      messageKey: String(item?.messageKey || "").trim() || null,
    }))
    .filter((item) => item.id && item.label && item.actionType);
}

function buildInsuranceMenuBody(runtime, MSG) {
  const tenantMessages = getTenantMessages(runtime);
  const title = String(
    tenantMessages.insuranceMenuTitle || MSG.INSURANCE_MENU_TITLE || ""
  ).trim();

  const options = getInsuranceOptions(runtime, MSG);

  const optionLines = options.map((item) => `${item.id}) ${item.label}`);
  const footer = "0) Voltar ao menu inicial";

  return [title, optionLines.join("\n"), footer].filter(Boolean).join("\n\n");
}

function findInsuranceOption(runtime, MSG, digits) {
  const options = getInsuranceOptions(runtime, MSG);
  return (
    options.find((item) => item.id === String(digits || "").trim()) || null
  );
}

function resolveInsuranceInfoMessage(runtime, MSG, option) {
  const tenantMessages = getTenantMessages(runtime);
  const rawKey = String(option?.messageKey || "").trim();

  if (!rawKey) return "";

  const fromRuntime = String(tenantMessages?.[rawKey] || "").trim();
  if (fromRuntime) return fromRuntime;

  return String(MSG?.[rawKey] || "").trim();
}

async function startBookingWithPlan({
  tenantId,
  traceId,
  phone,
  phoneNumberIdFallback,
  practitionerId,
  planKey,
  MSG,
}) {
  await updateSession(tenantId, phone, (s) => {
    s.booking = {
      ...(s.booking || {}),
      planKey,
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
    phoneNumberIdFallback,
  });
}

export async function handleMainMenuStep(flowCtx) {
  const {
    tenantId,
    runtime,
    traceId,
    phone,
    phoneNumberIdFallback,
    digits,
    state,
    MSG,
    practitionerId,
  } = flowCtx;

  if (state === "MAIN") {
    if (digits === "1") {
      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.PRIVATE_MENU,
        state: "PRIVATE_MENU",
        phoneNumberIdFallback,
      });
      return true;
    }

    if (digits === "2") {
      await sendAndSetState({
        tenantId,
        phone,
        body: buildInsuranceMenuBody(runtime, MSG),
        state: "INSURANCE_MENU",
        phoneNumberIdFallback,
      });
      return true;
    }

    if (digits === "3") {
      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.POS_MENU,
        state: "POS",
        phoneNumberIdFallback,
      });
      return true;
    }

    if (digits === "4") {
      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.ATENDENTE,
        state: "ATENDENTE",
        phoneNumberIdFallback,
      });
      return true;
    }

    await sendAndSetState({
      tenantId,
      phone,
      body: MSG.MENU,
      state: "MAIN",
      phoneNumberIdFallback,
    });
    return true;
  }

  if (state === "PRIVATE_MENU") {
    if (digits === "1") {
      await startBookingWithPlan({
        tenantId,
        traceId,
        phone,
        phoneNumberIdFallback,
        practitionerId,
        planKey: PLAN_KEYS.PRIVATE,
        MSG,
      });
      return true;
    }

    if (digits === "0") {
      await resetToMain(tenantId, phone, phoneNumberIdFallback, MSG);
      return true;
    }

    await sendAndSetState({
      tenantId,
      phone,
      body: MSG.PRIVATE_MENU,
      state: "PRIVATE_MENU",
      phoneNumberIdFallback,
    });
    return true;
  }

  if (state === "INSURANCE_MENU") {
    if (digits === "0") {
      await resetToMain(tenantId, phone, phoneNumberIdFallback, MSG);
      return true;
    }

    const selectedOption = findInsuranceOption(runtime, MSG, digits);

    if (!selectedOption) {
      await sendAndSetState({
        tenantId,
        phone,
        body: buildInsuranceMenuBody(runtime, MSG),
        state: "INSURANCE_MENU",
        phoneNumberIdFallback,
      });
      return true;
    }

    if (selectedOption.actionType === "INSURANCE_INFO_ONLY") {
      const infoMessage = resolveInsuranceInfoMessage(runtime, MSG, selectedOption);

      if (!infoMessage) {
        await sendAndSetState({
          tenantId,
          phone,
          body: buildInsuranceMenuBody(runtime, MSG),
          state: "INSURANCE_MENU",
          phoneNumberIdFallback,
        });
        return true;
      }

      await updateSession(tenantId, phone, (s) => {
        s.pending = {
          ...(s.pending || {}),
          insuranceOptionId: selectedOption.id,
          insuranceActionType: selectedOption.actionType,
          insuranceLabel: selectedOption.label,
          insuranceMessageKey: selectedOption.messageKey,
        };
      });

      await sendAndSetState({
        tenantId,
        phone,
        body: infoMessage,
        state: "INSURANCE_INFO",
        phoneNumberIdFallback,
      });
      return true;
    }

    if (selectedOption.actionType === "INSURANCE_DIRECT_BOOKING") {
      await updateSession(tenantId, phone, (s) => {
        s.booking = {
          ...(s.booking || {}),
          planKey: PLAN_KEYS.INSURED,
        };

        s.pending = {
          ...(s.pending || {}),
          insuranceOptionId: selectedOption.id,
          insuranceActionType: selectedOption.actionType,
          insuranceLabel: selectedOption.label,
          insuranceMessageKey: selectedOption.messageKey,
        };
      });

      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.INSURED_DIRECT_MENU,
        state: "INSURED_DIRECT",
        phoneNumberIdFallback,
      });
      return true;
    }

    await sendAndSetState({
      tenantId,
      phone,
      body: buildInsuranceMenuBody(runtime, MSG),
      state: "INSURANCE_MENU",
      phoneNumberIdFallback,
    });
    return true;
  }

  if (state === "INSURANCE_INFO") {
    if (digits === "9") {
      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.PRIVATE_MENU,
        state: "PRIVATE_MENU",
        phoneNumberIdFallback,
      });
      return true;
    }

    if (digits === "0") {
      await resetToMain(tenantId, phone, phoneNumberIdFallback, MSG);
      return true;
    }

    const selectedOption = findInsuranceOption(
      runtime,
      MSG,
      digits
    );

    if (selectedOption) {
      const infoMessage = resolveInsuranceInfoMessage(runtime, MSG, selectedOption);

      if (infoMessage) {
        await updateSession(tenantId, phone, (s) => {
          s.pending = {
            ...(s.pending || {}),
            insuranceOptionId: selectedOption.id,
            insuranceActionType: selectedOption.actionType,
            insuranceLabel: selectedOption.label,
            insuranceMessageKey: selectedOption.messageKey,
          };
        });

        await sendAndSetState({
          tenantId,
          phone,
          body: infoMessage,
          state: "INSURANCE_INFO",
          phoneNumberIdFallback,
        });
        return true;
      }
    }

    await sendAndSetState({
      tenantId,
      phone,
      body: buildInsuranceMenuBody(runtime, MSG),
      state: "INSURANCE_MENU",
      phoneNumberIdFallback,
    });
    return true;
  }

  if (state === "INSURED_DIRECT") {
    if (digits === "1") {
      await startBookingWithPlan({
        tenantId,
        traceId,
        phone,
        phoneNumberIdFallback,
        practitionerId,
        planKey: PLAN_KEYS.INSURED,
        MSG,
      });
      return true;
    }

    if (digits === "0") {
      await resetToMain(tenantId, phone, phoneNumberIdFallback, MSG);
      return true;
    }

    await sendAndSetState({
      tenantId,
      phone,
      body: MSG.INSURED_DIRECT_MENU,
      state: "INSURED_DIRECT",
      phoneNumberIdFallback,
    });
    return true;
  }

  return false;
}
