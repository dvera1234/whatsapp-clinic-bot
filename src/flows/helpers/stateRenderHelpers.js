import { setState } from "../../session/redisSession.js";
import { sendListMessage } from "../../whatsapp/sendListMessage.js";
import { handleMainMenuStep } from "../steps/mainMenu.js";

function normalizeState(state) {
  return String(state || "").trim();
}

function buildLgpdMenu(flowCtx) {
  const messages = flowCtx?.runtime?.content?.messages || {};
  const MSG = flowCtx?.MSG || {};

  const text = String(
    messages.lgpdConsent ||
      MSG.LGPD_CONSENT ||
      ""
  ).trim();

  if (!text) {
    throw new Error("TENANT_CONTENT_INVALID:messages.lgpdConsent_missing");
  }

  return {
    text,
    buttonText: String(
      messages.lgpdButtonText ||
        messages.listButtonText ||
        MSG.LGPD_BUTTON_TEXT ||
        "Selecionar"
    ).trim(),
    sectionTitle: String(
      messages.lgpdSectionTitle ||
        MSG.LGPD_SECTION_TITLE ||
        "Consentimento"
    ).trim(),
    options: [
      {
        id: "1",
        label: String(
          messages.lgpdAcceptLabel ||
            MSG.LGPD_ACCEPT_LABEL ||
            "Concordo e desejo continuar"
        ).trim(),
        description: String(
          messages.lgpdAcceptDescription ||
            MSG.LGPD_ACCEPT_DESCRIPTION ||
            ""
        ).trim(),
      },
      {
        id: "2",
        label: String(
          messages.lgpdRejectLabel ||
            MSG.LGPD_REJECT_LABEL ||
            "Não concordo"
        ).trim(),
        description: String(
          messages.lgpdRejectDescription ||
            MSG.LGPD_REJECT_DESCRIPTION ||
            ""
        ).trim(),
      },
    ],
  };
}

async function renderLgpdConsent(flowCtx) {
  const {
    tenantId,
    phone,
    phoneNumberIdFallback,
  } = flowCtx;

  const menuLike = buildLgpdMenu(flowCtx);

  await sendListMessage({
    tenantId,
    to: phone,
    phoneNumberIdFallback,
    body: menuLike.text,
    buttonText: menuLike.buttonText || "Selecionar",
    sections: [
      {
        title: menuLike.sectionTitle || "Consentimento",
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
