import { sendListMessage } from "../../whatsapp/sendListMessage.js";
import { dispatchAction } from "../actions/actionDispatcher.js";

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getRootMenu(runtime) {
  return isObject(runtime?.content?.menu) ? runtime.content.menu : null;
}

function getSubmenu(runtime, submenuKey) {
  const key = readString(submenuKey);
  if (!key) return null;

  return isObject(runtime?.content?.submenus?.[key])
    ? runtime.content.submenus[key]
    : null;
}

function parseSubmenuState(state) {
  const raw = readString(state);
  if (!raw.startsWith("MENU:")) return null;

  const submenuKey = raw.slice(5).trim();
  return submenuKey || null;
}

function ensureOptions(menuLike, fieldName) {
  const options = Array.isArray(menuLike?.options) ? menuLike.options : [];

  if (!options.length) {
    throw new Error(`TENANT_CONTENT_INVALID:${fieldName}.options_empty`);
  }

  return options;
}

function buildSections(menuLike, fieldName) {
  const options = ensureOptions(menuLike, fieldName);
  const sectionTitle =
    readString(menuLike?.sectionTitle) || "Opções disponíveis";

  return [
    {
      title: sectionTitle,
      rows: options.map((option) => ({
        id: String(option.id),
        title: readString(option.label) || String(option.id),
        description: readString(option.description),
      })),
    },
  ];
}

async function showMenu({
  tenantId,
  phone,
  phoneNumberId,
  menuLike,
  fieldName,
}) {
  const body = readString(menuLike?.text);

  if (!body) {
    throw new Error(`TENANT_CONTENT_INVALID:${fieldName}.text_missing`);
  }

  await sendListMessage({
    tenantId,
    to: phone,
    phoneNumberId,
    body,
    buttonText: readString(menuLike?.buttonText) || "Selecionar",
    sections: buildSections(menuLike, fieldName),
  });
}

function findSelectedOption(options, raw) {
  const selectedId = String(raw ?? "");
  return options.find((option) => String(option.id) === selectedId) || null;
}

export async function handleMainMenuStep(flowCtx) {
  const { tenantId, runtime, phone, phoneNumberId, raw, state } = flowCtx;

  if (state === "MAIN") {
    const menu = getRootMenu(runtime);

    if (!menu) {
      throw new Error("TENANT_CONTENT_INVALID:menu_missing");
    }

    const options = ensureOptions(menu, "menu");
    const selectedOption = findSelectedOption(options, raw);

    if (selectedOption) {
      return await dispatchAction(selectedOption.action, {
        ...flowCtx,
        menuOption: selectedOption,
      });
    }

    await showMenu({
      tenantId,
      phone,
      phoneNumberId,
      menuLike: menu,
      fieldName: "menu",
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

  const options = ensureOptions(submenu, `submenus.${submenuKey}`);
  const selectedOption = findSelectedOption(options, raw);

  if (selectedOption) {
    return await dispatchAction(selectedOption.action, {
      ...flowCtx,
      menuOption: selectedOption,
      currentSubmenuKey: submenuKey,
    });
  }

  await showMenu({
    tenantId,
    phone,
    phoneNumberId,
    menuLike: submenu,
    fieldName: `submenus.${submenuKey}`,
  });

  return true;
}
