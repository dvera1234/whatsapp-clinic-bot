import { updateSession } from "../../session/redisSession.js";
import {
  PLAN_KEYS,
  LGPD_TEXT_VERSION,
  LGPD_TEXT_HASH,
} from "../../config/constants.js";
import { audit } from "../../observability/audit.js";
import { maskPhone } from "../../utils/mask.js";
import { resetToMain, sendAndSetState } from "../helpers/flowHelpers.js";

function camelToConstKey(value = "") {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toUpperCase();
}

function buildInsuranceMenuBody(MSG) {
  const title = String(MSG.INSURANCE_MENU_TITLE || "").trim();
  const options = Array.isArray(MSG.INSURANCE_OPTIONS)
    ? MSG.INSURANCE_OPTIONS
    : [];

  const optionLines = options
    .filter(
      (item) =>
        item &&
        String(item.id || "").trim() &&
        String(item.label || "").trim()
    )
    .map((item) => `${item.id}) ${item.label}`);

  const footer = "0) Voltar ao menu inicial";

  return [title, optionLines.join("\n"), footer].filter(Boolean).join("\n\n");
}

function findInsuranceOption(MSG, digits) {
  const options = Array.isArray(MSG.INSURANCE_OPTIONS)
    ? MSG.INSURANCE_OPTIONS
    : [];

  return (
    options.find((item) => String(item?.id || "").trim() === String(digits)) ||
    null
  );
}

function resolveInsuranceInfoMessage(MSG, option) {
  const rawKey = String(option?.messageKey || "").trim();
  if (!rawKey) return "";

  const constKey = camelToConstKey(rawKey);
  return String(MSG?.[constKey] || "").trim();
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
        body: buildInsuranceMenuBody(MSG),
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

    const selectedOption = findInsuranceOption(MSG, digits);

    if (!selectedOption) {
      await sendAndSetState({
        tenantId,
        phone,
        body: buildInsuranceMenuBody(MSG),
        state: "INSURANCE_MENU",
        phoneNumberIdFallback,
      });
      return true;
    }

    if (selectedOption.actionType === "INSURANCE_INFO_ONLY") {
      const infoMessage = resolveInsuranceInfoMessage(MSG, selectedOption);

      if (!infoMessage) {
        await sendAndSetState({
          tenantId,
          phone,
          body: buildInsuranceMenuBody(MSG),
          state: "INSURANCE_MENU",
          phoneNumberIdFallback,
        });
        return true;
      }

      await updateSession(tenantId, phone, (s) => {
        s.pending = {
          ...(s.pending || {}),
          insuranceOptionId: String(selectedOption.id),
          insuranceActionType: selectedOption.actionType,
          insuranceLabel: String(selectedOption.label || ""),
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
          insuranceOptionId: String(selectedOption.id),
          insuranceActionType: selectedOption.actionType,
          insuranceLabel: String(selectedOption.label || ""),
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
      body: buildInsuranceMenuBody(MSG),
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

    await sendAndSetState({
      tenantId,
      phone,
      body: buildInsuranceMenuBody(MSG),
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
