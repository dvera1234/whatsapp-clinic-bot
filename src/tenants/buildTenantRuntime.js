function readString(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function readNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  return null;
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

function pushMissing(list, condition, fieldName) {
  if (condition) list.push(fieldName);
}

function pushInvalid(list, condition, fieldName) {
  if (condition) list.push(fieldName);
}

export function buildTenantRuntime(config = {}) {
  const missing = [];
  const invalid = [];

  const tenantId = readString(config?.tenantId);

  const identity = {
    key: readString(config?.providers?.identity?.key),
    baseUrl: readHttpsUrl(config?.providers?.identity?.baseUrl),
    user: readString(config?.providers?.identity?.user),
    pass: readString(config?.providers?.identity?.pass),
  };

  const access = {
    key: readString(config?.providers?.access?.key),
    baseUrl: readHttpsUrl(config?.providers?.access?.baseUrl),
  };

  const booking = {
    key: readString(config?.providers?.booking?.key),
    baseUrl: readHttpsUrl(config?.providers?.booking?.baseUrl),
  };

  pushMissing(missing, !tenantId, "tenantId");

  // identity (obrigatório)
  pushMissing(missing, !identity.key, "providers.identity.key");
  pushMissing(missing, !config?.providers?.identity?.baseUrl, "providers.identity.baseUrl");
  pushMissing(missing, !identity.user, "providers.identity.user");
  pushMissing(missing, !identity.pass, "providers.identity.pass");

  pushInvalid(
    invalid,
    !!config?.providers?.identity?.baseUrl && !identity.baseUrl,
    "providers.identity.baseUrl"
  );

  // access (obrigatório)
  pushMissing(missing, !access.key, "providers.access.key");
  pushMissing(missing, !config?.providers?.access?.baseUrl, "providers.access.baseUrl");

  pushInvalid(
    invalid,
    !!config?.providers?.access?.baseUrl && !access.baseUrl,
    "providers.access.baseUrl"
  );

  // booking (obrigatório)
  pushMissing(missing, !booking.key, "providers.booking.key");
  pushMissing(missing, !config?.providers?.booking?.baseUrl, "providers.booking.baseUrl");

  pushInvalid(
    invalid,
    !!config?.providers?.booking?.baseUrl && !booking.baseUrl,
    "providers.booking.baseUrl"
  );

  if (missing.length || invalid.length) {
    return {
      ok: false,
      missing,
      invalid,
    };
  }

  return {
    ok: true,
    value: {
      tenantId,

      clinic: {
        primaryPractitionerId: readNumber(config?.clinic?.codColaborador),
        defaultUnitId: readNumber(config?.clinic?.codUnidade),
        defaultSpecialtyId: readNumber(config?.clinic?.codEspecialidade),
      },

      plans: {
        privatePlanId: readNumber(config?.plans?.codPlanoParticular),
        insuredPlanId: readNumber(config?.plans?.codPlanoMedSeniorSp),
      },

      portal: {
        url: readHttpsUrl(config?.portal?.url),
      },

      support: {
        waNumber: readString(config?.support?.waNumber),
      },

      providers: {
        identity: identity.key,
        access: access.key,
        booking: booking.key,
      },

      integrations: {
        identity,
        access,
        booking,
      },

      content: config?.content ?? {},
    },
  };
}
