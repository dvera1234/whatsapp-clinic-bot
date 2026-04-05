import { sendList } from "./sender.js";

function validateSections(sections) {
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error("ListMessage requires at least one section");
  }

  for (const section of sections) {
    if (!section.title || !Array.isArray(section.rows) || !section.rows.length) {
      throw new Error("Invalid section format");
    }

    if (section.rows.length > 10) {
      throw new Error("WhatsApp limit: max 10 rows per section");
    }
  }
}

export async function sendListMessage({
  tenantId,
  to,
  phoneNumberIdFallback,
  header,
  body,
  footer,
  buttonText = "Selecionar",
  sections = [],
}) {
  if (!tenantId) throw new Error("sendListMessage requires tenantId");
  if (!to) throw new Error("sendListMessage requires to");
  if (!body) throw new Error("sendListMessage requires body");

  validateSections(sections);

  return sendList({
    tenantId,
    to,
    body,
    buttonText,
    sections,
    headerText: header,
    footerText: footer,
    phoneNumberIdFallback,
  });
}
