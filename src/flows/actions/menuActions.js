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
    helpers,
  } = flowCtx;

  const buildPlansMenu = helpers?.buildPlansMenu;

  const body =
    typeof buildPlansMenu === "function"
      ? buildPlansMenu(runtime)
      : (() => {
          const messages = getMessages(runtime);
          const plans = runtime?.content?.plans || [];

          const title =
            messages?.planSelectionPrompt ||
            "Selecione uma opção:";

          const lines = plans.map((p) => `${p.id}) ${p.label}`);

          return [title, lines.join("\n")].join("\n\n");
        })();

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
