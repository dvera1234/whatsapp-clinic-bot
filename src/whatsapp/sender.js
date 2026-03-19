import { errLog } from "../observability/audit.js";
import { maskPhone } from "../utils/mask.js";
import { fetchWithTimeout } from "../utils/time.js";
import { WHATSAPP_TOKEN } from "../config/env.js";

function getSendConfig({ tenantId, phoneNumberIdFallback }) {
  const safeTenantId = String(tenantId || "").trim();
  const token = String(WHATSAPP_TOKEN || "").trim();
  const phoneNumberId = String(phoneNumberIdFallback || "").trim();

  if (!safeTenantId) {
    errLog("WHATSAPP_SEND_CONFIG_MISSING_TENANT_ID", {
      hasPhoneNumberIdFallback: !!phoneNumberIdFallback,
    });
    return null;
  }

  if (!token) {
    errLog("WHATSAPP_SEND_CONFIG_MISSING_TOKEN", {
      tenantId: safeTenantId,
      hasPhoneNumberIdFallback: !!phoneNumberIdFallback,
    });
    return null;
  }

  if (!phoneNumberId) {
    errLog("WHATSAPP_SEND_CONFIG_MISSING_PHONE_NUMBER_ID", {
      tenantId: safeTenantId,
      hasFallback: !!phoneNumberIdFallback,
    });
    return null;
  }

  return {
    token,
    url: `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
  };
}

async function sendText({
  tenantId,
  to,
  body,
  phoneNumberIdFallback,
}) {
  const config = getSendConfig({ tenantId, phoneNumberIdFallback });
  if (!config) return false;

  const resp = await fetchWithTimeout(
    config.url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        text: { body },
      }),
    },
    15000
  );

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    errLog("WHATSAPP_SEND_TEXT_FAIL", {
      tenantId,
      phoneMasked: maskPhone(to),
      httpStatus: resp.status,
      responseBodyPresent: !!txt,
      responseBodyLen: txt ? String(txt).length : 0,
      bodyLength: String(body || "").length,
    });
    return false;
  }

  return true;
}

async function sendButtons({
  tenantId,
  to,
  body,
  buttons,
  phoneNumberIdFallback,
}) {
  const config = getSendConfig({ tenantId, phoneNumberIdFallback });
  if (!config) return false;

  const resp = await fetchWithTimeout(
    config.url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: body },
          action: {
            buttons: buttons.map((b) => ({
              type: "reply",
              reply: {
                id: b.id,
                title: b.title,
              },
            })),
          },
        },
      }),
    },
    15000
  );

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    errLog("WHATSAPP_SEND_BUTTONS_FAIL", {
      tenantId,
      phoneMasked: maskPhone(to),
      httpStatus: resp.status,
      responseBodyPresent: !!txt,
      responseBodyLen: txt ? String(txt).length : 0,
      buttonCount: Array.isArray(buttons) ? buttons.length : 0,
      bodyLength: String(body || "").length,
    });
    return false;
  }

  return true;
}

export {
  getSendConfig,
  sendText,
  sendButtons,
};
