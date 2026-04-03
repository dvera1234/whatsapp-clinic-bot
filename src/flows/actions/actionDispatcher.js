const ACTIONS = {};

export function registerAction(action, handler) {
  ACTIONS[action] = handler;
}

export async function dispatchAction(action, flowCtx) {
  const handler = ACTIONS[action];

  if (!handler) return false;

  return await handler(flowCtx);
}
