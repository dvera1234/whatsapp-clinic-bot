import { updateSession } from "../../session/redisSession.js";
import { sendAndSetState } from "../helpers/flowHelpers.js";
import { setStateAndRender } from "../helpers/stateRenderHelpers.js";

function getPlans(runtime) {
  return Array.isArray(runtime?.content?.plans)
    ? runtime.content.plans
    : [];
}

function getFlows(runtime) {
  return runtime?.content?.flows && typeof runtime.content.flows === "object"
    ? runtime.content.flows
    : {};
}

function findPlanByInput(runtime, raw) {
  const plans = getPlans(runtime);
  return plans.find((p) => String(p.id) === String(raw)) || null;
}

function resolveMessage(runtime, MSG, key) {
  if (!key) return "";
  return runtime?.content?.messages?.[key] || MSG?.[key] || "";
}

function resolvePlanFlow(runtime, plan) {
  const flowKey = String(plan?.flow || "").trim();
  const flows = getFlows(runtime);

  const flowConfig =
    flowKey && flows?.[flowKey] && typeof flows[flowKey] === "object"
      ? flows[flowKey]
      : null;

  const flowType = String(flowConfig?.type || flowKey || "CONTINUE")
    .trim()
    .toUpperCase();

  return {
    key: flowKey,
    type: flowType,
    config: flowConfig || null,
  };
}

function buildMenuStateFromTarget(target) {
  const normalized = String(target || "").trim();
  if (!normalized) return null;

  if (normalized === "MAIN" || normalized.startsWith("MENU:")) {
    return normalized;
  }

  return `MENU:${normalized}`;
}

export async function handlePlanSelectionStep(flowCtx) {
  const {
    tenantId,
    runtime,
    phone,
    phoneNumberIdFallback,
    raw,
    state,
    MSG,
    services,
  } = flowCtx;

  if (state !== "PLAN_PICK") return false;

  if (raw === "BACK_TO_MENU") {
    await setStateAndRender(flowCtx, "MAIN");
    return true;
  }

  const plan = findPlanByInput(runtime, raw);

  if (!plan) {
    await services.sendText({
      tenantId,
      to: phone,
      body:
        runtime?.content?.messages?.pickPlanButtonsOnly ||
        runtime?.content?.messages?.buttonsOnlyWarning ||
        MSG?.PICK_PLAN_BUTTONS_ONLY ||
        MSG?.BUTTONS_ONLY_WARNING,
      phoneNumberIdFallback,
    });
    return true;
  }

  const flow = resolvePlanFlow(runtime, plan);

  await updateSession(tenantId, phone, (s) => {
    s.booking = s.booking || {};
    s.booking.planId = String(plan.id);
    s.booking.planKey = String(plan.key || "");
    s.booking.planFlow = String(plan.flow || "");
    s.booking.planLabel = String(plan.label || "");
    s.booking.planMessageKey = String(plan.messageKey || "");
    s.booking.planNextState = String(plan.nextState || "");

    if (s.portal?.issue) delete s.portal.issue;
  });

  if (flow.type === "INFO_ONLY" || flow.type === "END") {
    const msg = resolveMessage(runtime, MSG, plan.messageKey);
    const nextState = String(plan?.nextState || "").trim() || null;

    await sendAndSetState({
      tenantId,
      phone,
      body: msg || null,
      state: nextState,
      phoneNumberIdFallback,
      flowCtx,
    });

    return true;
  }

  if (flow.type === "OPEN_SUBMENU" || flow.type === "DIRECT_BOOKING") {
    const targetState = buildMenuStateFromTarget(flow.config?.target);

    if (!targetState) {
      throw new Error(
        `TENANT_CONTENT_INVALID:flow_target_missing:${String(plan?.flow || "")}`
      );
    }

    await setStateAndRender(flowCtx, targetState);
    return true;
  }

  if (flow.type === "BOOKING" || flow.type === "CONTINUE") {
    const lgpdBody =
      runtime?.content?.messages?.lgpdConsent ||
      MSG?.LGPD_CONSENT ||
      "";

    if (String(lgpdBody).trim()) {
      await setStateAndRender(flowCtx, "LGPD_CONSENT");
      return true;
    }

    await sendAndSetState({
      tenantId,
      phone,
      body:
        runtime?.content?.messages?.askCpfPortal ||
        MSG?.ASK_CPF_PORTAL,
      state: "WZ_CPF",
      phoneNumberIdFallback,
    });
    return true;
  }

  throw new Error(
    `TENANT_CONTENT_INVALID:unsupported_plan_flow:${String(plan?.flow || "")}`
  );
}
