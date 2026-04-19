import { setState } from "../../session/redisSession.js";
import { sendListMessage } from "../../whatsapp/sendListMessage.js";
import { handleMainMenuStep } from "../steps/mainMenu.js";

// =========================

function normalizeState(state) {
  return String(state || "").trim();
}

// =========================
// LGPD MENU
// =========================

function buildLgpdMenu(flowCtx) {
  const messages = flowCtx?.runtime?.content?.messages || {};

  const text = String(messages.lgpdConsent || "").trim();
  const buttonText = String(messages.lgpdButtonText || "").trim();
  const sectionTitle = String(messages.lgpdSectionTitle || "").trim();
  const acceptLabel = String(messages.lgpdAcceptLabel || "").trim();
  const rejectLabel = String(messages.lgpdRejectLabel || "").trim();

  if (!text || !buttonText || !sectionTitle || !acceptLabel || !rejectLabel) {
    throw new Error("TENANT_CONTENT_INVALID:lgpd_messages");
  }

  return {
    text,
    buttonText,
    sectionTitle,
    options: [
      {
        id: "LGPD_ACCEPT",
        label: acceptLabel,
        description: String(messages.lgpdAcceptDescription || "").trim(),
      },
      {
        id: "LGPD_REJECT",
        label: rejectLabel,
        description: String(messages.lgpdRejectDescription || "").trim(),
      },
    ],
  };
}

// =========================

async function renderLgpdConsent(flowCtx) {
  const { tenantId, phone, phoneNumberId } = flowCtx;
  const menu = buildLgpdMenu(flowCtx);

  await sendListMessage({
    tenantId,
    to: phone,
    phoneNumberId,
    body: menu.text,
    buttonText: menu.buttonText,
    sections: [
      {
        title: menu.sectionTitle,
        rows: menu.options.map((o) => ({
          id: o.id,
          title: o.label,
          description: o.description,
        })),
      },
    ],
  });

  return true;
}

// =========================
// STATE RENDER
// =========================

export async function renderState(flowCtx, explicitState = null) {
  const state = normalizeState(explicitState || flowCtx?.state);
  if (!state) return false;

  if (state === "MAIN" || state.startsWith("MENU:")) {
    return await handleMainMenuStep({
      ...flowCtx,
      state,
      raw: "",
      upper: "",
      digits: "",
    });
  }

  if (state === "LGPD_CONSENT") {
    return await renderLgpdConsent({
      ...flowCtx,
      state,
      raw: "",
      upper: "",
      digits: "",
    });
  }

  return false;
}

// =========================

export async function setStateAndRender(flowCtx, targetState) {
  const state = normalizeState(targetState);

  if (!state) {
    throw new Error("INVALID_STATE");
  }

  await setState(flowCtx.tenantId, flowCtx.phone, state);

  return await renderState(
    {
      ...flowCtx,
      state,
    },
    state
  );
}
