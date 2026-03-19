function readString(value) {
  const v = String(value ?? "").trim();
  return v || "";
}

function buildTenantRegistry(entries = []) {
  const registry = {};

  for (const entry of entries) {
    const tenantId = readString(entry?.tenantId);
    const channelId = readString(entry?.channelId);

    if (!tenantId || !channelId) {
      continue;
    }

    registry[channelId] = tenantId;
  }

  return Object.freeze(registry);
}

export const tenantRegistry = buildTenantRegistry([
  {
    tenantId: "dr_davidvera_campinas",
    channelId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  },

  // Exemplo futuro:
  // {
  //   tenantId: "clinica_sp",
  //   channelId: process.env.CLINICA_SP_WHATSAPP_PHONE_NUMBER_ID,
  // },
]);
