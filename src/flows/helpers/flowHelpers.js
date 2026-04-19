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
  return runtime && typeof runtime === "object" ? runtime : null;
}

// =========================
// FAIL SAFE
// =========================

export async function failSafeTenantConfigError({
  tenantId,
  phone,
  phoneNumberId,
}) {
  try {
    await sendText({
      tenantId,
      to: phone,
      body:
        "⚠️ Não foi possível continuar seu atendimento automático neste momento. Por favor, tente novamente em instantes.",
      phoneNumberId,
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

    delete s.pending;
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
// SEND + STATE
// =========================

export async function sendAndSetState({
  tenantId,
  phone,
  body,
  state,
  phoneNumberId,
}) {
  const text = String(body || "").trim();

  if (text) {
    const sent = await sendText({
      tenantId,
      to: phone,
      body: text,
      phoneNumberId,
    });

    if (!sent) {
      throw new Error("WHATSAPP_SEND_FAILED");
    }
  }

  const nextState = String(state || "").trim();
  if (!nextState) return true;

  await setState(tenantId, phone, nextState);
  return true;
}
