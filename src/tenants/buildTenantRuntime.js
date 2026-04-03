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

function pushMissing(list, condition, fieldName) {
  if (condition) list.push(fieldName);
}

function pushInvalid(list, condition, fieldName) {
  if (condition) list.push(fieldName);
}

function isSupportedIdentityProvider(value) {
  return ["versatilis"].includes(value);
}

function isSupportedAccessProvider(value) {
  return ["versatilis"].includes(value);
}

function isSupportedBookingProvider(value) {
  return ["versatilis", "google_calendar"].includes(value);
}

function normalizeContent(content) {
  return content && typeof content === "object" ? content : {};
}

export function buildTenantRuntime(config = {}) {
  const missing = [];
  const invalid = [];

  const tenantId = readString(config?.tenantId);

  const clinic = {
    providerId: readNumber(config?.clinic?.providerId),
  };

  const bookingDefaults = {
    unitId: readNumber(config?.bookingDefaults?.unitId),
    specialtyId: readNumber(config?.bookingDefaults?.specialtyId),
  };

  const planMappings = {
    PRIVATE: {
      externalId: readNumber(config?.planMappings?.PRIVATE?.externalId),
    },
    INSURED: {
      externalId: readNumber(config?.planMappings?.INSURED?.externalId),
    },
  };

  const plans = {
    supportedKeys: ["PRIVATE", "INSURED"],
  };

  const portal = {
    url: readHttpsUrl(config?.portal?.url),
  };

  const support = {
    waNumber: readDigits(config?.support?.waNumber),
  };

  const identity = {
    key: readString(config?.providers?.identity?.key),
    baseUrl: readHttpsUrl(config?.providers?.identity?.baseUrl),
    user: readString(config?.providers?.identity?.user),
    pass: readString(config?.providers?.identity?.pass),
  };

  const access = {
    key: readString(config?.providers?.access?.key),
    baseUrl: readHttpsUrl(config?.providers?.access?.baseUrl),
    user: readString(config?.providers?.access?.user),
    pass: readString(config?.providers?.access?.pass),
  };

  const booking = {
    key: readString(config?.providers?.booking?.key),
    baseUrl: readHttpsUrl(config?.providers?.booking?.baseUrl),
    user: readString(config?.providers?.booking?.user),
    pass: readString(config?.providers?.booking?.pass),
    calendarId: readString(config?.providers?.booking?.calendarId),
  };

  pushMissing(missing, !tenantId, "tenantId");

  pushMissing(missing, clinic.providerId === null, "clinic.providerId");

  pushMissing(
    missing,
    planMappings.PRIVATE.externalId === null,
    "planMappings.PRIVATE.externalId"
  );
  pushMissing(
    missing,
    planMappings.INSURED.externalId === null,
    "planMappings.INSURED.externalId"
  );

  pushMissing(missing, !config?.portal?.url, "portal.url");
  pushInvalid(invalid, !!config?.portal?.url && !portal.url, "portal.url");

  pushMissing(missing, !support.waNumber, "support.waNumber");

  pushMissing(missing, !identity.key, "providers.identity.key");
  pushInvalid(
    invalid,
    !!identity.key && !isSupportedIdentityProvider(identity.key),
    "providers.identity.key"
  );

  if (identity.key === "versatilis") {
    pushMissing(
      missing,
      !config?.providers?.identity?.baseUrl,
      "providers.identity.baseUrl"
    );
    pushMissing(missing, !identity.user, "providers.identity.user");
    pushMissing(missing, !identity.pass, "providers.identity.pass");

    pushInvalid(
      invalid,
      !!config?.providers?.identity?.baseUrl && !identity.baseUrl,
      "providers.identity.baseUrl"
    );
  }

  pushMissing(missing, !access.key, "providers.access.key");
  pushInvalid(
    invalid,
    !!access.key && !isSupportedAccessProvider(access.key),
    "providers.access.key"
  );

  if (access.key === "versatilis") {
    pushMissing(
      missing,
      !config?.providers?.access?.baseUrl,
      "providers.access.baseUrl"
    );
    pushMissing(missing, !access.user, "providers.access.user");
    pushMissing(missing, !access.pass, "providers.access.pass");

    pushInvalid(
      invalid,
      !!config?.providers?.access?.baseUrl && !access.baseUrl,
      "providers.access.baseUrl"
    );
  }

  pushMissing(missing, !booking.key, "providers.booking.key");
  pushInvalid(
    invalid,
    !!booking.key && !isSupportedBookingProvider(booking.key),
    "providers.booking.key"
  );

  if (booking.key === "versatilis") {
    pushMissing(
      missing,
      !config?.providers?.booking?.baseUrl,
      "providers.booking.baseUrl"
    );
    pushMissing(missing, !booking.user, "providers.booking.user");
    pushMissing(missing, !booking.pass, "providers.booking.pass");

    pushInvalid(
      invalid,
      !!config?.providers?.booking?.baseUrl && !booking.baseUrl,
      "providers.booking.baseUrl"
    );

    pushMissing(
      missing,
      bookingDefaults.unitId === null,
      "bookingDefaults.unitId"
    );
    pushMissing(
      missing,
      bookingDefaults.specialtyId === null,
      "bookingDefaults.specialtyId"
    );
  }

  if (booking.key === "google_calendar") {
    pushMissing(missing, !booking.calendarId, "providers.booking.calendarId");
  }

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

      clinic,

      bookingDefaults,

      plans,

      planMappings,

      portal,

      support,

      providers: {
        identity: identity.key,
        access: access.key,
        booking: booking.key,
      },

      integrations: {
        identity: {
          key: identity.key,
          baseUrl: identity.baseUrl,
          user: identity.user,
          pass: identity.pass,
        },

        access: {
          key: access.key,
          baseUrl: access.baseUrl,
          user: access.user,
          pass: access.pass,
        },

        booking:
          booking.key === "google_calendar"
            ? {
                key: booking.key,
                calendarId: booking.calendarId,
              }
            : {
                key: booking.key,
                baseUrl: booking.baseUrl,
                user: booking.user,
                pass: booking.pass,
                defaults: {
                  providerId: clinic.providerId,
                  unitId: bookingDefaults.unitId,
                  specialtyId: bookingDefaults.specialtyId,
                },
                planMappings,
              },
      },

      content: normalizeContent(config?.content),
    },
  };
}
