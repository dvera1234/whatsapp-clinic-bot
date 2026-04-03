import { sendListMessage } from "../../whatsapp/sendListMessage.js";
import { dispatchAction } from "../actions/actionDispatcher.js";

function getMenu(runtime) {
  return runtime?.content?.menu || {};
}

export async function handleMainMenuStep(flowCtx) {
  const {
    tenantId,
    runtime,
    phone,
    phoneNumberIdFallback,
    raw,
    state,
  } = flowCtx;

  if (state !== "MAIN") return false;

  const menu = getMenu(runtime);
  const options = Array.isArray(menu?.options) ? menu.options : [];

  const selected = options.find((opt) => opt.id === raw);

  // 👉 clique válido
  if (selected) {
    return await dispatchAction(selected.action, {
      ...flowCtx,
      menuOption: selected,
    });
  }

  // 👉 mostrar menu (LIST)
  await sendListMessage({
    tenantId,
    to: phone,
    phoneNumberId: phoneNumberIdFallback,
    body: menu.text,
    buttonText: "Selecionar",
    sections: [
      {
        title: "Menu",
        rows: options.map((opt) => ({
          id: opt.id,
          title: opt.label,
        })),
      },
    ],
  });

  return true;
}
