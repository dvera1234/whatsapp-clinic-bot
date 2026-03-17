function readString(value) {
  const v = String(value ?? "").trim();
  return v || "";
}

function buildTenantRegistry(entries = []) {
  const registry = {};

  for (const entry of entries) {
    const tenantId = readString(entry?.tenantId);
    const phoneNumberId = readString(entry?.phoneNumberId);

    if (!tenantId || !phoneNumberId) {
      continue;
    }

    registry[phoneNumberId] = tenantId;
  }

  return Object.freeze(registry);
}

export const tenantRegistry = buildTenantRegistry([
  {
    tenantId: "dr_davidvera_campinas",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  },

  // Exemplo futuro:
  // {
  //   tenantId: "clinica_sp",
  //   phoneNumberId: process.env.CLINICA_SP_WHATSAPP_PHONE_NUMBER_ID,
  // },
]);
