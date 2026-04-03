import {
  getSession,
  setState,
  updateSession,
} from "../../session/redisSession.js";
import { PLAN_KEYS } from "../../config/constants.js";
import { audit } from "../../observability/audit.js";
import { sanitizeForLog } from "../../utils/logSanitizer.js";
import { maskPhone } from "../../utils/mask.js";

function getRawMessages(runtime) {
  return runtime?.content?.messages || {};
}

function getInsuranceOptions(runtime) {
  const rawMessages = getRawMessages(runtime);
  const options = rawMessages?.insuranceOptions;

  if (!Array.isArray(options)) return [];

  return options
    .map((item) => ({
      id: String(item?.id || "").trim(),
      label: String(item?.label || "").trim(),
      actionType: String(item?.actionType || "").trim(),
      messageKey: String(item?.messageKey || "").trim() || null,
      raw: item || {},
    }))
    .filter((item) => item.id && item.label && item.actionType);
}

function buildInsuranceMenuText(MSG, runtime) {
  const options = getInsuranceOptions(runtime);
  const title = String(MSG?.INSURANCE_MENU_TITLE || "").trim();

  const body = options.map((item) => `${item.id}) ${item.label}`).join("\n");

  return [title, body].filter(Boolean).join("\n\n");
}

function getInsuranceInfoBody(runtime, option) {
  const rawMessages = getRawMessages(runtime);
  const messageKey = String(option?.messageKey || "").trim();

  if (!messageKey) return "";
  return String(rawMessages?.[messageKey] || "").trim();
}

async function sendMainMenu({
  tenantId,
  phone,
  phoneNumberIdFallback,
  MSG,
  services,
}) {
  await setState(tenantId, phone, "MAIN");
  await services.sendText({
    tenantId,
    to: phone,
    body: MSG.MENU,
    phoneNumberIdFallback,
  });
}

async function sendPrivateMenu({
  tenantId,
  phone,
  phoneNumberIdFallback,
  MSG,
  services,
}) {
  await updateSession(tenantId, phone, (sess) => {
    sess.booking = sess.booking || {};
    sess.booking.planKey = PLAN_KEYS.PRIVATE;
    delete sess.booking.selectedInsuranceOption;
  });

  await setState(tenantId, phone, "PARTICULAR");
  await services.sendText({
    tenantId,
    to: phone,
    body: MSG.PRIVATE_MENU,
    phoneNumberIdFallback,
  });
}

async function sendInsuredDirectMenu({
  tenantId,
  phone,
  phoneNumberIdFallback,
  MSG,
  services,
}) {
  await setState(tenantId, phone, "INSURED_DIRECT_MENU");
  await services.sendText({
    tenantId,
    to: phone,
    body: MSG.INSURED_DIRECT_MENU,
    phoneNumberIdFallback,
  });
}

export async function handleInsuranceSelectionStep(flowCtx) {
  const {
    tenantId,
    runtime,
    traceId,
    phone,
    phoneNumberIdFallback,
    raw,
    digits,
    state,
    MSG,
    services,
  } = flowCtx;

  if (state === "CONVENIOS") {
    const options = getInsuranceOptions(runtime);

    if (!options.length) {
      audit(
        "INSURANCE_OPTIONS_INVALID",
        sanitizeForLog({
          tenantId,
          traceId,
          tracePhone: maskPhone(phone),
          state,
          reason: "insuranceOptions ausente ou inválido",
        })
      );

      await sendMainMenu({
        tenantId,
        phone,
        phoneNumberIdFallback,
        MSG,
        services,
      });
      return true;
    }

    const input = String(digits || raw || "").trim();

    if (input === "0") {
      await sendMainMenu({
        tenantId,
        phone,
        phoneNumberIdFallback,
        MSG,
        services,
      });
      return true;
    }

    const selected = options.find((item) => item.id === input) || null;

    if (!selected) {
      await services.sendText({
        tenantId,
        to: phone,
        body: buildInsuranceMenuText(MSG, runtime),
        phoneNumberIdFallback,
      });
      return true;
    }

    await updateSession(tenantId, phone, (sess) => {
      sess.booking = sess.booking || {};
      sess.booking.selectedInsuranceOption = {
        id: selected.id,
        label: selected.label,
        actionType: selected.actionType,
        messageKey: selected.messageKey,
      };
    });

    audit(
      "INSURANCE_OPTION_SELECTED",
      sanitizeForLog({
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        selectedInsuranceId: selected.id,
        selectedInsuranceLabel: selected.label,
        actionType: selected.actionType,
      })
    );

    if (selected.actionType === "INSURANCE_INFO_ONLY") {
      const infoBody = getInsuranceInfoBody(runtime, selected);

      if (!infoBody) {
        audit(
          "INSURANCE_INFO_MESSAGE_MISSING",
          sanitizeForLog({
            tenantId,
            traceId,
            tracePhone: maskPhone(phone),
            selectedInsuranceId: selected.id,
            selectedInsuranceLabel: selected.label,
            messageKey: selected.messageKey,
          })
        );

        await services.sendText({
          tenantId,
          to: phone,
          body: buildInsuranceMenuText(MSG, runtime),
          phoneNumberIdFallback,
        });
        return true;
      }

      await setState(tenantId, phone, "INSURANCE_INFO");
      await services.sendText({
        tenantId,
        to: phone,
        body: infoBody,
        phoneNumberIdFallback,
      });
      return true;
    }

    if (selected.actionType === "INSURANCE_DIRECT_BOOKING") {
      await updateSession(tenantId, phone, (sess) => {
        sess.booking = sess.booking || {};
        sess.booking.planKey = PLAN_KEYS.INSURED;
      });

      await sendInsuredDirectMenu({
        tenantId,
        phone,
        phoneNumberIdFallback,
        MSG,
        services,
      });
      return true;
    }

    audit(
      "INSURANCE_ACTION_TYPE_UNSUPPORTED",
      sanitizeForLog({
        tenantId,
        traceId,
        tracePhone: maskPhone(phone),
        selectedInsuranceId: selected.id,
        selectedInsuranceLabel: selected.label,
        actionType: selected.actionType,
      })
    );

    await services.sendText({
      tenantId,
      to: phone,
      body: buildInsuranceMenuText(MSG, runtime),
      phoneNumberIdFallback,
    });
    return true;
  }

  if (state === "INSURANCE_INFO") {
    const input = String(digits || raw || "").trim();

    if (input === "0") {
      await sendMainMenu({
        tenantId,
        phone,
        phoneNumberIdFallback,
        MSG,
        services,
      });
      return true;
    }

    if (input === "9") {
      await sendPrivateMenu({
        tenantId,
        phone,
        phoneNumberIdFallback,
        MSG,
        services,
      });
      return true;
    }

    const session = await getSession(tenantId, phone);
    const selected = session?.booking?.selectedInsuranceOption || null;
    const infoBody = getInsuranceInfoBody(runtime, selected);

    await services.sendText({
      tenantId,
      to: phone,
      body: infoBody || buildInsuranceMenuText(MSG, runtime),
      phoneNumberIdFallback,
    });
    return true;
  }

  if (state === "INSURED_DIRECT_MENU") {
    const input = String(digits || raw || "").trim();

    if (input === "0") {
      await sendMainMenu({
        tenantId,
        phone,
        phoneNumberIdFallback,
        MSG,
        services,
      });
      return true;
    }

    if (input === "1") {
      await updateSession(tenantId, phone, (sess) => {
        sess.booking = sess.booking || {};
        sess.booking.planKey = PLAN_KEYS.INSURED;
      });

      await setState(tenantId, phone, "WZ_CPF");
      await services.sendText({
        tenantId,
        to: phone,
        body: MSG.ASK_CPF_PORTAL,
        phoneNumberIdFallback,
      });
      return true;
    }

    await services.sendText({
      tenantId,
      to: phone,
      body: MSG.INSURED_DIRECT_MENU,
      phoneNumberIdFallback,
    });
    return true;
  }

  return false;
}
