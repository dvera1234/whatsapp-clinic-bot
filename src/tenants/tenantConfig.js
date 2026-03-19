function readString(value) {
  const v = String(value ?? "").trim();
  return v || "";
}

function readNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readDigits(value) {
  return String(value ?? "").replace(/\D+/g, "");
}

function readHttpsUrl(value) {
  const raw = readString(value);
  if (!raw) return "";

  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function readBool(value) {
  return readString(value).toLowerCase() === "true";
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergeDeep(target, source) {
  if (!isPlainObject(target)) return source;
  if (!isPlainObject(source)) return target;

  const out = { ...target };

  for (const key of Object.keys(source)) {
    const targetValue = out[key];
    const sourceValue = source[key];

    if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
      out[key] = mergeDeep(targetValue, sourceValue);
    } else {
      out[key] = sourceValue;
    }
  }

  return out;
}

function buildTenantConfig({
  tenantId,
  env = process.env,
  overrides = {},
}) {
  const baseConfig = {
    tenantId: readString(tenantId),

    channel: {
      phoneNumberId: readString(env.WHATSAPP_PHONE_NUMBER_ID),
      whatsappToken: readString(env.WHATSAPP_TOKEN),
    },

    clinic: {
      defaultUnitId: readNumber(env.COD_UNIDADE),
      defaultSpecialtyId: readNumber(env.COD_ESPECIALIDADE),
      primaryPractitionerId: readNumber(env.COD_COLABORADOR),
    },

    plans: {
      privatePlanId: readNumber(env.COD_PLANO_PARTICULAR),
      insuredPlanId: readNumber(env.COD_PLANO_MEDSENIOR_SP),
    },

    portal: {
      url: readHttpsUrl(env.PORTAL_URL),
    },

    support: {
      waNumber: readDigits(env.SUPPORT_WA_NUMBER),
    },

    services: {
      identity: {
        providerKey: "provider_default",
      },
      access: {
        providerKey: "provider_default",
      },
      booking: {
        providerKey: "provider_default",
      },
    },

    providers: {
      provider_default: {
        baseUrl: readString(env.VERSATILIS_BASE),
        user: readString(env.VERSATILIS_USER),
        pass: readString(env.VERSATILIS_PASS),
      },

      calendar_default: {
        calendarId: readString(env.GOOGLE_CALENDAR_ID),
      },
    },

    flags: {
      debugWebhook: readBool(env.DEBUG_WEBHOOK),
      debugVersa: readBool(env.DEBUG_VERSA),
      debugVersaShape: readBool(env.DEBUG_VERSA_SHAPE),
      debugRedis: readBool(env.DEBUG_REDIS),
      enableDebug: readBool(env.ENABLE_DEBUG),
    },
  };

  return mergeDeep(baseConfig, overrides);
}

export const tenantConfigs = {
  dr_davidvera_campinas: buildTenantConfig({
    tenantId: "dr_davidvera_campinas",
  }),

  // Exemplo futuro:
  // clinica_sp: buildTenantConfig({
  //   tenantId: "clinica_sp",
  //   env: {
  //     ...process.env,
  //     WHATSAPP_PHONE_NUMBER_ID: process.env.CLINICA_SP_WHATSAPP_PHONE_NUMBER_ID,
  //     WHATSAPP_TOKEN: process.env.CLINICA_SP_WHATSAPP_TOKEN,
  //     COD_COLABORADOR: process.env.CLINICA_SP_COD_COLABORADOR,
  //     COD_UNIDADE: process.env.CLINICA_SP_COD_UNIDADE,
  //     COD_ESPECIALIDADE: process.env.CLINICA_SP_COD_ESPECIALIDADE,
  //     COD_PLANO_PARTICULAR: process.env.CLINICA_SP_COD_PLANO_PARTICULAR,
  //     COD_PLANO_MEDSENIOR_SP: process.env.CLINICA_SP_COD_PLANO_MEDSENIOR_SP,
  //     PORTAL_URL: process.env.CLINICA_SP_PORTAL_URL,
  //     SUPPORT_WA_NUMBER: process.env.CLINICA_SP_SUPPORT_WA_NUMBER,
  //     VERSATILIS_BASE: process.env.CLINICA_SP_VERSATILIS_BASE,
  //     VERSATILIS_USER: process.env.CLINICA_SP_VERSATILIS_USER,
  //     VERSATILIS_PASS: process.env.CLINICA_SP_VERSATILIS_PASS,
  //     GOOGLE_CALENDAR_ID: process.env.CLINICA_SP_GOOGLE_CALENDAR_ID,
  //   },
  // }),

  // Exemplo futuro híbrido:
  // clinica_hibrida: buildTenantConfig({
  //   tenantId: "clinica_hibrida",
  //   overrides: {
  //     services: {
  //       identity: { providerKey: "provider_default" },
  //       access: { providerKey: "provider_default" },
  //       booking: { providerKey: "calendar_default" },
  //     },
  //   },
  // }),
};

export { buildTenantConfig };
