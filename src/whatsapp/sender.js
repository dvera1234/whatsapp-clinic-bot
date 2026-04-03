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

function truncate(str, max) {
  const s = String(str || "");
  if (!max || s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
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
                id: String(b.id || ""),
                title: truncate(b.title, 20),
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

async function sendList({
  tenantId,
  to,
  body,
  buttonText = "Ver opções",
  sections,
  footerText,
  headerText,
  phoneNumberIdFallback,
}) {
  const config = getSendConfig({ tenantId, phoneNumberIdFallback });
  if (!config) return false;

  const safeSections = Array.isArray(sections)
    ? sections
        .map((section) => ({
          title: truncate(section?.title || "", 24),
          rows: Array.isArray(section?.rows)
            ? section.rows
                .filter((row) => row && row.id && row.title)
                .map((row) => ({
                  id: String(row.id),
                  title: truncate(row.title, 24),
                  description: row.description
                    ? truncate(row.description, 72)
                    : undefined,
                }))
            : [],
        }))
        .filter((section) => section.rows.length > 0)
    : [];

  if (!safeSections.length) {
    errLog("WHATSAPP_SEND_LIST_INVALID", {
      tenantId,
      phoneMasked: maskPhone(to),
      hasBody: !!body,
      hasSections: Array.isArray(sections),
      sectionCount: Array.isArray(sections) ? sections.length : 0,
    });
    return false;
  }

  const interactive = {
    type: "list",
    body: { text: String(body || "") },
    action: {
      button: truncate(buttonText, 20) || "Ver opções",
      sections: safeSections,
    },
  };

  if (headerText) {
    interactive.header = {
      type: "text",
      text: truncate(headerText, 60),
    };
  }

  if (footerText) {
    interactive.footer = {
      text: truncate(footerText, 60),
    };
  }

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
        interactive,
      }),
    },
    15000
  );

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    errLog("WHATSAPP_SEND_LIST_FAIL", {
      tenantId,
      phoneMasked: maskPhone(to),
      httpStatus: resp.status,
      responseBodyPresent: !!txt,
      responseBodyLen: txt ? String(txt).length : 0,
      sectionCount: safeSections.length,
      rowCount: safeSections.reduce((acc, s) => acc + s.rows.length, 0),
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
  sendList,
};
