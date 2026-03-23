import { updateSession } from "../../session/redisSession.js";
import {
  PLAN_KEYS,
  LGPD_TEXT_VERSION,
  LGPD_TEXT_HASH,
} from "../../config/constants.js";
import { audit } from "../../observability/audit.js";
import { maskPhone } from "../../utils/mask.js";
import { resetToMain, sendAndSetState } from "../helpers/flowHelpers.js";

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
        body: MSG.INSURANCE_MENU,
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

    if (digits === "1") {
      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.INSURANCE_INFO_1,
        state: "INSURANCE_INFO",
        phoneNumberIdFallback,
      });
      return true;
    }

    if (digits === "2") {
      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.INSURANCE_INFO_2,
        state: "INSURANCE_INFO",
        phoneNumberIdFallback,
      });
      return true;
    }

    if (digits === "3") {
      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.INSURANCE_INFO_3,
        state: "INSURANCE_INFO",
        phoneNumberIdFallback,
      });
      return true;
    }

    if (digits === "4") {
      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.INSURANCE_INFO_4,
        state: "INSURANCE_INFO",
        phoneNumberIdFallback,
      });
      return true;
    }

    if (digits === "5") {
      await updateSession(tenantId, phone, (s) => {
        s.booking = {
          ...(s.booking || {}),
          planKey: PLAN_KEYS.INSURED,
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
      body: MSG.INSURANCE_MENU,
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
      body: MSG.INSURANCE_MENU,
      state: "INSURANCE_MENU",
      phoneNumberIdFallback,
    });
    return true;
  }

  if (state === "INSURED_DIRECT") {
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
      body: MSG.INSURED_DIRECT_MENU,
      state: "INSURED_DIRECT",
      phoneNumberIdFallback,
    });
    return true;
  }

  return false;
}
