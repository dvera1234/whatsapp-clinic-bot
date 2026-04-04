const ACTIONS = {};

export function registerAction(action, handler) {
  const actionName = String(action || "").trim();

  if (!actionName) {
    throw new Error("registerAction requires a valid action name");
  }

  if (typeof handler !== "function") {
    throw new Error(`registerAction requires a function handler for ${actionName}`);
  }

  ACTIONS[actionName] = handler;
}

export async function dispatchAction(action, flowCtx) {
  const actionName = String(action || "").trim();
  const handler = ACTIONS[actionName];

  if (!handler) {
    return false;
  }

  return await handler(flowCtx);
}
