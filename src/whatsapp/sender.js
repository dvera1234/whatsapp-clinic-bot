import { errLog } from "../observability/audit.js";
import { maskPhone } from "../utils/mask.js";
import { fetchWithTimeout } from "../utils/time.js";

function readString(value) {
  const v = String(value ?? "").trim();
  return v || "";
}

function getChannelConfig({ tenantId, runtime, phoneNumberId }) {
  const safeTenantId = readString(tenantId);
  const channelId = readString(phoneNumberId);

  const token = readString(runtime?.channels?.token);

  if (!safeTenantId) {
    errLog("WHATSAPP_SEND_CONFIG_MISSING_TENANT_ID", {});
    return null;
  }

  if (!token) {
    errLog("WHATSAPP_SEND_CONFIG_MISSING_TOKEN", {
      tenantId: safeTenantId,
    });
    return null;
  }

  if (!channelId) {
    errLog("WHATSAPP_SEND_CONFIG_MISSING_PHONE_NUMBER_ID", {
      tenantId: safeTenantId,
    });
    return null;
  }

  return {
    token,
    url: `https://graph.facebook.com/v19.0/${channelId}/messages`,
  };
}

function truncate(str, max) {
  const s = String(str || "");
  if (!max || s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

async function sendRequest(config, payload, meta) {
  const resp = await fetchWithTimeout(
    config.url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
    15000
  );

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");

    errLog(meta.errorEvent, {
      ...meta.log,
      httpStatus: resp.status,
      responseBodyPresent: !!txt,
      responseBodyLen: txt ? String(txt).length : 0,
    });

    return {
      ok: false,
      status: resp.status,
    };
  }

  return {
    ok: true,
    status: resp.status,
  };
}

async function sendText({
  tenantId,
  runtime,
  to,
  body,
  phoneNumberId,
}) {
  const config = getChannelConfig({ tenantId, runtime, phoneNumberId });
  if (!config) return { ok: false };

  return sendRequest(
    config,
    {
      messaging_product: "whatsapp",
      to,
      text: { body },
    },
    {
      errorEvent: "WHATSAPP_SEND_TEXT_FAIL",
      log: {
        tenantId,
        phoneMasked: maskPhone(to),
        bodyLength: String(body || "").length,
      },
    }
  );
}

async function sendButtons({
  tenantId,
  runtime,
  to,
  body,
  buttons,
  phoneNumberId,
}) {
  const config = getChannelConfig({ tenantId, runtime, phoneNumberId });
  if (!config) return { ok: false };

  return sendRequest(
    config,
    {
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
    },
    {
      errorEvent: "WHATSAPP_SEND_BUTTONS_FAIL",
      log: {
        tenantId,
        phoneMasked: maskPhone(to),
        buttonCount: Array.isArray(buttons) ? buttons.length : 0,
      },
    }
  );
}

async function sendList({
  tenantId,
  runtime,
  to,
  body,
  buttonText,
  sections,
  footerText,
  headerText,
  phoneNumberId,
}) {
  const config = getChannelConfig({ tenantId, runtime, phoneNumberId });
  if (!config) return { ok: false };

  const safeSections = Array.isArray(sections)
    ? sections
        .map((section) => ({
          title: truncate(section?.title || "", 24),
          rows: (section?.rows || [])
            .filter((r) => r?.id && r?.title)
            .map((r) => ({
              id: String(r.id),
              title: truncate(r.title, 24),
              description: r.description
                ? truncate(r.description, 72)
                : undefined,
            })),
        }))
        .filter((s) => s.rows.length > 0)
    : [];

  if (!safeSections.length) {
    errLog("WHATSAPP_SEND_LIST_INVALID", {
      tenantId,
      phoneMasked: maskPhone(to),
    });
    return { ok: false };
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

  return sendRequest(
    config,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive,
    },
    {
      errorEvent: "WHATSAPP_SEND_LIST_FAIL",
      log: {
        tenantId,
        phoneMasked: maskPhone(to),
        sectionCount: safeSections.length,
      },
    }
  );
}

export {
  sendText,
  sendButtons,
  sendList,
};
