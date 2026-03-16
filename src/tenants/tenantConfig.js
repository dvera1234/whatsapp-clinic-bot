export const tenantConfigs = {
  dr_david_campinas: {
    tenantId: "dr_davidvera_campinas",

    channel: {
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
      whatsappToken: process.env.WHATSAPP_TOKEN,
    },

    scheduling: {
      provider: "versatilis",
    },

    portal: {
      url: process.env.PORTAL_URL,
    },
  },
};
