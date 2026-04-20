import {
  setState,
  updateSession,
  clearSession,
} from "../../session/redisSession.js";
import { sendText } from "../../whatsapp/sender.js";
import { setStateAndRender } from "./stateRenderHelpers.js";
import { audit } from "../../observability/audit.js";

// =========================
// HELPERS
// =========================

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getRuntimeMessages(runtime) {
  return runtime?.content?.messages || {};
}

function resolveFailSafeMessage(runtime) {
  const messages = getRuntimeMessages(runtime);

  return (
    readString(messages.tenantConfigUnavailable) ||
    readString(messages.failSafeTenantConfigError) ||
    readString(messages.genericFlowError) ||
    "⚠️ Não foi possível continuar seu atendimento automático neste momento. Por favor, tente novamente em instantes."
  );
}

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
  runtime = null,
}) {
  const body = resolveFailSafeMessage(runtime);

  try {
    const sent = await sendText({
      tenantId,
      to: phone,
      body,
      phoneNumberId,
    });

    if (!sent) {
      audit("FAIL_SAFE_TENANT_CONFIG_ERROR_SEND_FAILED", {
        tenantId,
      });
    }
  } catch (error) {
    audit("FAIL_SAFE_TENANT_CONFIG_ERROR_FAILED", {
      tenantId,
      errorName: error?.name || "Error",
      errorMessage: error?.message || "unknown",
    });
  }
}

// =========================
// SESSION CLEAN
// =========================

export async function clearTransientPortalData(tenantId, phone) {
  await updateSession(tenantId, phone, (session) => {
    if (!session || typeof session !== "object") return;

    if (session.portal && typeof session.portal === "object") {
      session.portal.form = {};
      delete session.portal.missing;
      delete session.portal.issue;
    }

    delete session.pending;
  });
}

// =========================
// RESET FLOW
// =========================

export async function resetToMain(flowCtx) {
  const { tenantId, phone } = flowCtx;

  await clearSession(tenantId, phone);

  audit("FLOW_RESET_TO_MAIN", {
    tenantId,
  });

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
  const text = readString(body);

  if (text) {
    const sent = await sendText({
      tenantId,
      to: phone,
      body: text,
      phoneNumberId,
    });

    if (!sent) {
      audit("WHATSAPP_SEND_FAILED", {
        tenantId,
        nextState: readString(state) || null,
      });
      throw new Error("WHATSAPP_SEND_FAILED");
    }
  }

  const nextState = readString(state);
  if (!nextState) {
    return true;
  }

  await setState(tenantId, phone, nextState);
  return true;
}
