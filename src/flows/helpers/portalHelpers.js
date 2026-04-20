import { getWizardPromptMap } from "./contentHelpers.js";

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function getPromptByWizardState(runtime, state, MSG) {
  const promptMap = getWizardPromptMap(runtime);

  const normalizedState = readString(state);
  const messageKey =
    readString(promptMap[normalizedState]) ||
    readString(promptMap.default);

  if (!messageKey) {
    throw new Error("TENANT_CONTENT_MISSING:wizard.promptByState.default");
  }

  const prompt = MSG?.[messageKey];

  if (!readString(prompt)) {
    throw new Error(`TENANT_CONTENT_MISSING:MSG.${messageKey}`);
  }

  return prompt;
}
