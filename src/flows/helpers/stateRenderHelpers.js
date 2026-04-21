import { setState } from "../../session/redisSession.js";
import { sendListMessage } from "../../whatsapp/sendListMessage.js";
import { handleMainMenuStep } from "../steps/mainMenu.js";
import { audit } from "../../observability/audit.js";

// =========================
// HELPERS
// =========================

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeState(state) {
  return readString(state);
}

function getDispatch(runtime) {
  return runtime?.content?.dispatch || {};
}

function getMessages(runtime) {
  return runtime?.content?.messages || {};
}

function resolveHandlerName(runtime, state) {
  const normalizedState = normalizeState(state);
  const dispatch = getDispatch(runtime);

  const stateHandlers =
    dispatch && typeof dispatch.stateHandlers === "object"
      ? dispatch.stateHandlers
      : {};

  const statePrefixes =
    dispatch && typeof dispatch.statePrefixes === "object"
      ? dispatch.statePrefixes
      : {};

  if (stateHandlers[normalizedState]) {
    return readString(stateHandlers[normalizedState]);
  }

  const matchedPrefix = Object.keys(statePrefixes).find(
    (prefix) =>
      normalizedState === prefix ||
      normalizedState.startsWith(`${prefix}:`)
  );

  if (matchedPrefix) {
    return readString(statePrefixes[matchedPrefix]);
  }

  return "";
}

function buildLgpdMenu(runtime) {
  const messages = getMessages(runtime);

  const text = readString(messages.lgpdConsent);
  const buttonText =
    readString(messages.lgpdButtonText) ||
    readString(messages.listButtonText);
  const sectionTitle = readString(messages.lgpdSectionTitle);
  const acceptLabel = readString(messages.lgpdAcceptLabel);
  const rejectLabel = readString(messages.lgpdRejectLabel);

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
        description: readString(messages.lgpdAcceptDescription),
      },
      {
        id: "LGPD_REJECT",
        label: rejectLabel,
        description: readString(messages.lgpdRejectDescription),
      },
    ],
  };
}

// =========================
// RENDERERS
// =========================

async function renderMainMenu(flowCtx, state) {
  return await handleMainMenuStep({
    ...flowCtx,
    state,
    raw: "",
    upper: "",
    digits: "",
  });
}

async function renderLgpdConsent(flowCtx, state) {
  const { tenantId, phone, phoneNumberId, runtime } = flowCtx;
  const menu = buildLgpdMenu(runtime);

  await sendListMessage({
    tenantId,
    runtime,
    to: phone,
    phoneNumberId,
    body: menu.text,
    buttonText: menu.buttonText,
    sections: [
      {
        title: menu.sectionTitle,
        rows: menu.options.map((option) => ({
          id: option.id,
          title: option.label,
          description: option.description,
        })),
      },
    ],
  });

  audit("STATE_RENDERED", {
    tenantId,
    state,
    renderer: "lgpdConsent",
  });

  return true;
}

const STATE_RENDERERS = Object.freeze({
  mainMenu: renderMainMenu,
  lgpdConsent: renderLgpdConsent,
});

function resolveRenderer(flowCtx, state) {
  const handlerName = resolveHandlerName(flowCtx?.runtime, state);
  const renderer = STATE_RENDERERS[handlerName];

  if (!renderer) {
    return null;
  }

  return renderer;
}

// =========================
// STATE RENDER
// =========================

export async function renderState(flowCtx, explicitState = null) {
  const state = normalizeState(explicitState || flowCtx?.state);
  if (!state) {
    return false;
  }

  const renderer = resolveRenderer(flowCtx, state);

  if (!renderer) {
    audit("STATE_RENDERER_NOT_FOUND", {
      tenantId: flowCtx?.tenantId,
      state,
    });
    return false;
  }

  return await renderer(
    {
      ...flowCtx,
      state,
      raw: "",
      upper: "",
      digits: "",
    },
    state
  );
}

// =========================
// SET + RENDER
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
