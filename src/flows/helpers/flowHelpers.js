import {
  setState,
  updateSession,
  clearSession,
} from "../../session/redisSession.js";
import { sendText } from "../../whatsapp/sender.js";

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

export async function resetToMain(
  tenantId,
  phone,
  phoneNumberIdFallback,
  MSG
) {
  await updateSession(tenantId, phone, (s) => {
    if (s?.portal) {
      s.portal.form = {};
      delete s.portal.issue;
      delete s.portal.missing;
    }
    if (s?.pending) delete s.pending;
  });

  await sendAndSetState({
    tenantId,
    phone,
    body: MSG.MENU,
    state: "MAIN",
    phoneNumberIdFallback,
  });
}

export async function sendAndSetState({
  tenantId,
  phone,
  body,
  state,
  phoneNumberIdFallback,
  resetSession = false,
  clearTransientOnly = false,
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
      if (s?.pending) delete s.pending;
    });
  }

  const sent = await sendText({
    tenantId,
    to: phone,
    body,
    phoneNumberIdFallback,
  });

  if (!sent) return false;

  if (state) {
    await setState(tenantId, phone, state);
  }

  return true;
}
