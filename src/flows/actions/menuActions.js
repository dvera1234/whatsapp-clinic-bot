import { sendListMessage } from "../../whatsapp/sendListMessage.js";
import { sendAndSetState } from "../helpers/flowHelpers.js";

// =========================
// HELPERS
// =========================

function getMessages(runtime) {
  return runtime?.content?.messages || {};
}

// =========================
// ACTIONS
// =========================

export async function handlePlanMenu(flowCtx) {
  const {
    tenantId,
    phone,
    runtime,
    phoneNumberIdFallback,
  } = flowCtx;

  const messages = getMessages(runtime);
  const plans = runtime?.content?.plans || [];

  if (!plans.length) {
    throw new Error("TENANT_CONTENT_INVALID:plans_empty");
  }

  const title =
    messages?.planSelectionPrompt ||
    "Selecione uma opção:";

  const sections = [
    {
      title: "Opções disponíveis",
      rows: plans.map((p) => ({
        id: String(p.id),
        title: p.label,
        description: p.description || "",
      })),
    },
  ];

  await sendListMessage({
    tenantId,
    to: phone,
    phoneNumberId: phoneNumberIdFallback,
    body: title,
    buttonText: "Selecionar",
    sections,
  });

  await sendAndSetState({
    tenantId,
    phone,
    body: null, // importante: não envia texto duplicado
    state: "PLAN_PICK",
    phoneNumberIdFallback,
  });

  return true;
}

export async function handlePos(flowCtx) {
  const { tenantId, phone, runtime, phoneNumberIdFallback } = flowCtx;

  const messages = getMessages(runtime);

  await sendAndSetState({
    tenantId,
    phone,
    body: messages?.posMenu || "Pós-operatório",
    state: "POS",
    phoneNumberIdFallback,
  });

  return true;
}

export async function handleAttendant(flowCtx) {
  const { tenantId, phone, runtime, phoneNumberIdFallback } = flowCtx;

  const messages = getMessages(runtime);

  await sendAndSetState({
    tenantId,
    phone,
    body: messages?.attendant || "Falar com atendente",
    state: "ATENDENTE",
    phoneNumberIdFallback,
  });

  return true;
}
