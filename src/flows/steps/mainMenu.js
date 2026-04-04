import { sendListMessage } from "../../whatsapp/sendListMessage.js";
import { dispatchAction } from "../actions/actionDispatcher.js";

function getRootMenu(runtime) {
  return runtime?.content?.menu || null;
}

function getSubmenu(runtime, submenuKey) {
  return runtime?.content?.submenus?.[submenuKey] || null;
}

function buildMenuStateKey(submenuKey) {
  return `MENU:${String(submenuKey || "").trim()}`;
}

function parseSubmenuState(state) {
  const raw = String(state || "").trim();
  if (!raw.startsWith("MENU:")) return null;

  const submenuKey = raw.slice(5).trim();
  return submenuKey || null;
}

function buildSections(menuLike) {
  const options = Array.isArray(menuLike?.options) ? menuLike.options : [];
  const sectionTitle =
    String(menuLike?.sectionTitle || "").trim() || "Opções disponíveis";

  return [
    {
      title: sectionTitle,
      rows: options.map((opt) => ({
        id: String(opt.id),
        title: String(opt.label || opt.id),
        description: String(opt.description || "").trim(),
      })),
    },
  ];
}

async function showMenu({
  tenantId,
  phone,
  phoneNumberIdFallback,
  menuLike,
}) {
  await sendListMessage({
    tenantId,
    to: phone,
    phoneNumberId: phoneNumberIdFallback,
    body: String(menuLike?.text || "").trim(),
    buttonText: String(menuLike?.buttonText || "").trim() || "Selecionar",
    sections: buildSections(menuLike),
  });
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

  if (state === "MAIN") {
    const menu = getRootMenu(runtime);
    if (!menu) {
      throw new Error("TENANT_CONTENT_INVALID:menu_missing");
    }

    const options = Array.isArray(menu?.options) ? menu.options : [];
    const selected = options.find((opt) => String(opt.id) === String(raw));

    if (selected) {
      return await dispatchAction(selected.action, {
        ...flowCtx,
        menuOption: selected,
      });
    }

    await showMenu({
      tenantId,
      phone,
      phoneNumberIdFallback,
      menuLike: menu,
    });

    return true;
  }

  const submenuKey = parseSubmenuState(state);
  if (!submenuKey) {
    return false;
  }

  const submenu = getSubmenu(runtime, submenuKey);
  if (!submenu) {
    throw new Error(`TENANT_CONTENT_INVALID:submenu_missing:${submenuKey}`);
  }

  const options = Array.isArray(submenu?.options) ? submenu.options : [];
  const selected = options.find((opt) => String(opt.id) === String(raw));

  if (selected) {
    return await dispatchAction(selected.action, {
      ...flowCtx,
      menuOption: selected,
      currentSubmenuKey: submenuKey,
    });
  }

  await showMenu({
    tenantId,
    phone,
    phoneNumberIdFallback,
    menuLike: submenu,
  });

  return true;
}
