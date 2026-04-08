import { setState } from "../../session/redisSession.js";
import { sendListMessage } from "../../whatsapp/sendListMessage.js";
import { handleMainMenuStep } from "../steps/mainMenu.js";

function normalizeState(state) {
  return String(state || "").trim();
}

function buildLgpdMenu(flowCtx) {
  const messages = flowCtx?.runtime?.content?.messages || {};

  const text = String(messages.lgpdConsent || "").trim();
  if (!text) {
    throw new Error("TENANT_CONTENT_INVALID:messages.lgpdConsent_missing");
  }

  const buttonText = String(messages.lgpdButtonText || "").trim();
  if (!buttonText) {
    throw new Error("TENANT_CONTENT_INVALID:messages.lgpdButtonText_missing");
  }

  const sectionTitle = String(messages.lgpdSectionTitle || "").trim();
  if (!sectionTitle) {
    throw new Error("TENANT_CONTENT_INVALID:messages.lgpdSectionTitle_missing");
  }

  const acceptLabel = String(messages.lgpdAcceptLabel || "").trim();
  if (!acceptLabel) {
    throw new Error("TENANT_CONTENT_INVALID:messages.lgpdAcceptLabel_missing");
  }

  const rejectLabel = String(messages.lgpdRejectLabel || "").trim();
  if (!rejectLabel) {
    throw new Error("TENANT_CONTENT_INVALID:messages.lgpdRejectLabel_missing");
  }

  return {
    text,
    buttonText,
    sectionTitle,
    options: [
      {
        id: "1",
        label: acceptLabel,
        description: String(messages.lgpdAcceptDescription || "").trim(),
      },
      {
        id: "2",
        label: rejectLabel,
        description: String(messages.lgpdRejectDescription || "").trim(),
      },
    ],
  };
}

async function renderLgpdConsent(flowCtx) {
  const { tenantId, phone, phoneNumberId } = flowCtx;

  const menuLike = buildLgpdMenu(flowCtx);

  await sendListMessage({
    tenantId,
    to: phone,
    phoneNumberId,
    body: menuLike.text,
    buttonText: menuLike.buttonText,
    sections: [
      {
        title: menuLike.sectionTitle,
        rows: menuLike.options.map((opt) => ({
          id: String(opt.id),
          title: String(opt.label || opt.id),
          description: String(opt.description || "").trim(),
        })),
      },
    ],
  });

  return true;
}

export async function renderState(flowCtx, explicitState = null) {
  const targetState = normalizeState(explicitState || flowCtx?.state);

  if (!targetState) {
    return false;
  }

  if (targetState === "MAIN" || targetState.startsWith("MENU:")) {
    return await handleMainMenuStep({
      ...flowCtx,
      state: targetState,
      raw: "",
      upper: "",
      digits: "",
    });
  }

  if (targetState === "LGPD_CONSENT") {
    return await renderLgpdConsent({
      ...flowCtx,
      state: targetState,
      raw: "",
      upper: "",
      digits: "",
    });
  }

  return false;
}

export async function setStateAndRender(flowCtx, targetState) {
  const normalized = normalizeState(targetState);

  if (!normalized) {
    throw new Error("setStateAndRender requires a valid target state");
  }

  await setState(flowCtx.tenantId, flowCtx.phone, normalized);

  return await renderState(
    {
      ...flowCtx,
      state: normalized,
    },
    normalized
  );
}
