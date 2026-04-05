import {
  setState,
  updateSession,
  clearSession,
} from "../../session/redisSession.js";

import { sendText } from "../../whatsapp/sender.js";
import { setStateAndRender } from "./stateRenderHelpers.js";

// =========================
// RUNTIME
// =========================

export function resolveRuntimeFromContext(context = {}) {
  const runtime = context?.runtime;

  if (!runtime || typeof runtime !== "object") {
    return null;
  }

  return runtime;
}

// =========================
// FAIL SAFE
// =========================

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

// =========================
// SESSION CLEAN
// =========================

export async function clearTransientPortalData(tenantId, phone) {
  await updateSession(tenantId, phone, (s) => {
    if (!s) return;

    if (s.portal) {
      s.portal.form = {};
      delete s.portal.missing;
      delete s.portal.issue;
    }

    if (s.pending) {
      delete s.pending;
    }
  });
}

// =========================
// RESET FLOW
// =========================

export async function resetToMain(flowCtx) {
  const { tenantId, phone } = flowCtx;

  await clearSession(tenantId, phone);

  return await setStateAndRender(flowCtx, "MAIN");
}

// =========================
// CORE SEND + STATE
// =========================

export async function sendAndSetState({
  tenantId,
  phone,
  body,
  state,
  phoneNumberIdFallback,
}) {
  const normalizedBody = String(body || "").trim();

  if (normalizedBody) {
    const sent = await sendText({
      tenantId,
      to: phone,
      body: normalizedBody,
      phoneNumberIdFallback,
    });

    if (!sent) return false;
  }

  const normalizedState = String(state || "").trim();

  if (!normalizedState) return true;

  await setState(tenantId, phone, normalizedState);
  return true;
}
