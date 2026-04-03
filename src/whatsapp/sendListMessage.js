import { sendWhatsAppMessage } from "./sender.js";

export async function sendListMessage({
  to,
  phoneNumberId,
  header,
  body,
  footer,
  buttonText = "Selecionar",
  sections = [],
}) {
  if (!sections.length) {
    throw new Error("ListMessage requires at least one section");
  }

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: header
        ? {
            type: "text",
            text: header,
          }
        : undefined,
      body: {
        text: body,
      },
      footer: footer
        ? {
            text: footer,
          }
        : undefined,
      action: {
        button: buttonText,
        sections: sections.map((section) => ({
          title: section.title,
          rows: section.rows.map((row) => ({
            id: String(row.id),
            title: row.title,
            description: row.description || "",
          })),
        })),
      },
    },
  };

  return sendWhatsAppMessage({
    phoneNumberId,
    payload,
  });
}
