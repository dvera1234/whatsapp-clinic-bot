import { setState } from "../../session/redisSession.js";
import { handleMainMenuStep } from "../steps/mainMenu.js";

function normalizeState(state) {
  return String(state || "").trim();
}

export async function renderStateUi(flowCtx, explicitState = null) {
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

  return false;
}

export async function setStateAndRender(flowCtx, targetState) {
  const normalized = normalizeState(targetState);

  if (!normalized) {
    throw new Error("setStateAndRender requires a valid target state");
  }

  await setState(flowCtx.tenantId, flowCtx.phone, normalized);

  return await renderStateUi(
    {
      ...flowCtx,
      state: normalized,
    },
    normalized
  );
}
