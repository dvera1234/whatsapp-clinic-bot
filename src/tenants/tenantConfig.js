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

export const tenantConfigs = {
  dr_davidvera_campinas: {
    tenantId: "dr_davidvera_campinas",

    channel: {
      phoneNumberId: readString(process.env.WHATSAPP_PHONE_NUMBER_ID),
      whatsappToken: readString(process.env.WHATSAPP_TOKEN),
    },

    scheduling: {
      provider: "versatilis",
      codColaborador: readNumber(process.env.COD_COLABORADOR),
    },

    clinic: {
      codUnidade: readNumber(process.env.COD_UNIDADE),
      codEspecialidade: readNumber(process.env.COD_ESPECIALIDADE),
    },

    plans: {
      codPlanoParticular: readNumber(process.env.COD_PLANO_PARTICULAR),
      codPlanoMedSeniorSp: readNumber(process.env.COD_PLANO_MEDSENIOR_SP),
    },

    portal: {
      url: readHttpsUrl(process.env.PORTAL_URL),
    },

    support: {
      waNumber: readDigits(process.env.SUPPORT_WA_NUMBER),
    },

    integrations: {
      versatilis: {
        baseUrl: readString(process.env.VERSATILIS_BASE),
        user: readString(process.env.VERSATILIS_USER),
        pass: readString(process.env.VERSATILIS_PASS),
      },
    },

    flags: {
      debugWebhook: readString(process.env.DEBUG_WEBHOOK) === "true",
      debugVersa: readString(process.env.DEBUG_VERSA) === "true",
      debugVersaShape: readString(process.env.DEBUG_VERSA_SHAPE) === "true",
      debugRedis: readString(process.env.DEBUG_REDIS) === "true",
      enableDebug: readString(process.env.ENABLE_DEBUG) === "true",
    },
  },
};
