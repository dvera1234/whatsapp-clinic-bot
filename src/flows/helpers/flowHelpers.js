import {
  setState,
  updateSession,
  clearSession,
} from "../../session/redisSession.js";
import { sendText } from "../../whatsapp/sender.js";
import { setStateAndRender } from "./stateRenderHelpers.js";

function isRenderableMenuState(state) {
  const normalized = String(state || "").trim();
  return normalized === "MAIN" || normalized.startsWith("MENU:");
}

export function resolveRuntimeFromContext(context = {}) {
  const runtime =
    context?.runtime ||
    context?.tenantRuntime ||
    context?.resolvedRuntime ||
    null;

  if (!runtime || typeof runtime !== "object") {
    return null;
  }

  return runtime;
}

export async function failSafeTenantConfigError({
  tenantId,
  phone,
  phoneNumberIdFallback,
}) {
  try {
    await sendText({
      tenantId,
      to: phone,
      body:
        "⚠️ Não foi possível continuar seu atendimento automático neste momento. Por favor, tente novamente em instantes.",
      phoneNumberIdFallback,
    });
  } catch {}
}

export async function clearTransientPortalData(tenantId, phone) {
  await updateSession(tenantId, phone, (s) => {
    if (!s?.portal) return;

    s.portal.form = {};
    delete s.portal.missing;
    delete s.portal.issue;
  });
}

export async function resetToMain(flowCtx) {
  const { tenantId, phone } = flowCtx;

  await updateSession(tenantId, phone, (s) => {
    if (s?.portal) {
      s.portal.form = {};
      delete s.portal.issue;
      delete s.portal.missing;
    }

    if (s?.pending) {
      delete s.pending;
    }
  });

  return await setStateAndRender(flowCtx, "MAIN");
}

export async function sendAndSetState({
  tenantId,
  phone,
  body,
  state,
  phoneNumberIdFallback,
  resetSession = false,
  clearTransientOnly = false,
  flowCtx = null,
}) {
  if (resetSession) {
    await clearSession(tenantId, phone);
  } else if (clearTransientOnly) {
    await updateSession(tenantId, phone, (s) => {
      if (s?.portal) {
        s.portal.form = {};
        delete s.portal.issue;
        delete s.portal.missing;
      }

      if (s?.pending) {
        delete s.pending;
      }
    });
  }

  const normalizedBody = String(body || "").trim();

  if (normalizedBody) {
    const sent = await sendText({
      tenantId,
      to: phone,
      body: normalizedBody,
      phoneNumberIdFallback,
    });

    if (!sent) {
      return false;
    }
  }

  const normalizedState = String(state || "").trim();

  if (!normalizedState) {
    return true;
  }

  if (isRenderableMenuState(normalizedState)) {
    if (!flowCtx) {
      throw new Error(
        `sendAndSetState requires flowCtx when state is renderable: ${normalizedState}`
      );
    }

    return await setStateAndRender(
      {
        ...flowCtx,
        tenantId,
        phone,
        phoneNumberIdFallback,
        state: normalizedState,
      },
      normalizedState
    );
  }

  await setState(tenantId, phone, normalizedState);
  return true;
}
