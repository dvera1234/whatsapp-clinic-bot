import { sendAndSetState } from "../helpers/flowHelpers.js";

export async function handlePlanMenu(flowCtx) {
  const { tenantId, phone, runtime, phoneNumberIdFallback } = flowCtx;

  const plans = runtime?.content?.plans || [];

  const title =
    runtime?.content?.messages?.planSelectionPrompt ||
    "Selecione uma opção:";

  const lines = plans.map((p) => `${p.id}) ${p.label}`);

  const body = [title, lines.join("\n")].join("\n\n");

  await sendAndSetState({
    tenantId,
    phone,
    body,
    state: "PLAN_PICK",
    phoneNumberIdFallback,
  });

  return true;
}

export async function handlePos(flowCtx) {
  const { tenantId, phone, runtime, phoneNumberIdFallback } = flowCtx;

  await sendAndSetState({
    tenantId,
    phone,
    body: runtime?.content?.messages?.posMenu,
    state: "POS",
    phoneNumberIdFallback,
  });

  return true;
}

export async function handleAttendant(flowCtx) {
  const { tenantId, phone, runtime, phoneNumberIdFallback } = flowCtx;

  await sendAndSetState({
    tenantId,
    phone,
    body: runtime?.content?.messages?.attendant,
    state: "ATENDENTE",
    phoneNumberIdFallback,
  });

  return true;
}
