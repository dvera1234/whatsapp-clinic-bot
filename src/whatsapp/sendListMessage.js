import { sendList } from "./sender.js";

export async function sendListMessage({
  tenantId,
  to,
  phoneNumberId,
  phoneNumberIdFallback,
  header,
  body,
  footer,
  buttonText = "Selecionar",
  sections = [],
}) {
  if (!Array.isArray(sections) || !sections.length) {
    throw new Error("ListMessage requires at least one section");
  }

  return sendList({
    tenantId,
    to,
    body,
    buttonText,
    sections,
    headerText: header,
    footerText: footer,
    phoneNumberIdFallback: phoneNumberIdFallback || phoneNumberId,
  });
}
