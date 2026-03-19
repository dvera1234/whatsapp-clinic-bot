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

function pushIfMissing(list, condition, fieldName) {
  if (condition) list.push(fieldName);
}

function isSupportedIdentityProvider(value) {
  return ["provider_default"].includes(value);
}

function isSupportedAccessProvider(value) {
  return ["provider_default"].includes(value);
}

function isSupportedBookingProvider(value) {
  return ["provider_default", "calendar_default"].includes(value);
}

export function buildTenantRuntime(tenantConfig = {}) {
  const tenantId = readString(tenantConfig?.tenantId);

  const identityProviderKey = readString(
    tenantConfig?.services?.identity?.providerKey || "provider_default"
  );

  const accessProviderKey = readString(
    tenantConfig?.services?.access?.providerKey || "provider_default"
  );

  const bookingProviderKey = readString(
    tenantConfig?.services?.booking?.providerKey || "provider_default"
  );

  const primaryPractitionerId = readNumber(
    tenantConfig?.clinic?.primaryPractitionerId
  );

  const defaultUnitId = readNumber(tenantConfig?.clinic?.defaultUnitId);
  const defaultSpecialtyId = readNumber(
    tenantConfig?.clinic?.defaultSpecialtyId
  );

  const privatePlanId = readNumber(tenantConfig?.plans?.privatePlanId);
  const insuredPlanId = readNumber(tenantConfig?.plans?.insuredPlanId);

  const portalUrl = readHttpsUrl(tenantConfig?.portal?.url);
  const supportWa = readDigits(tenantConfig?.support?.waNumber);

  const defaultProviderBaseUrl = readString(
    tenantConfig?.providers?.provider_default?.baseUrl
  );
  const defaultProviderUser = readString(
    tenantConfig?.providers?.provider_default?.user
  );
  const defaultProviderPass = readString(
    tenantConfig?.providers?.provider_default?.pass
  );

  const defaultCalendarId = readString(
    tenantConfig?.providers?.calendar_default?.calendarId
  );

  const missing = [];
  const invalid = [];

  pushIfMissing(missing, !tenantId, "tenantId");

  if (!isSupportedIdentityProvider(identityProviderKey)) {
    invalid.push("services.identity.providerKey");
  }

  if (!isSupportedAccessProvider(accessProviderKey)) {
    invalid.push("services.access.providerKey");
  }

  if (!isSupportedBookingProvider(bookingProviderKey)) {
    invalid.push("services.booking.providerKey");
  }

  pushIfMissing(
    missing,
    !primaryPractitionerId,
    "clinic.primaryPractitionerId"
  );
  pushIfMissing(missing, !defaultUnitId, "clinic.defaultUnitId");
  pushIfMissing(missing, !defaultSpecialtyId, "clinic.defaultSpecialtyId");
  pushIfMissing(missing, !privatePlanId, "plans.privatePlanId");
  pushIfMissing(missing, !insuredPlanId, "plans.insuredPlanId");
  pushIfMissing(
    missing,
    !supportWa || supportWa.length < 10,
    "support.waNumber"
  );

  const needsDefaultProvider =
    identityProviderKey === "provider_default" ||
    accessProviderKey === "provider_default" ||
    bookingProviderKey === "provider_default";

  if (needsDefaultProvider) {
    pushIfMissing(
      missing,
      !defaultProviderBaseUrl,
      "providers.provider_default.baseUrl"
    );
    pushIfMissing(
      missing,
      !defaultProviderUser,
      "providers.provider_default.user"
    );
    pushIfMissing(
      missing,
      !defaultProviderPass,
      "providers.provider_default.pass"
    );
  }

  if (bookingProviderKey === "calendar_default") {
    pushIfMissing(
      missing,
      !defaultCalendarId,
      "providers.calendar_default.calendarId"
    );
  }

  if (invalid.length || missing.length) {
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

      providers: {
        identityProvider: identityProviderKey,
        accessProvider: accessProviderKey,
        bookingProvider: bookingProviderKey,
      },

      clinic: {
        primaryPractitionerId,
        defaultUnitId,
        defaultSpecialtyId,
      },

      plans: {
        privatePlanId,
        insuredPlanId,
      },

      portal: {
        url: portalUrl,
      },

      support: {
        waNumber: supportWa,
      },

      services: {
        identity: {
          providerKey: identityProviderKey,
        },
        access: {
          providerKey: accessProviderKey,
        },
        booking: {
          providerKey: bookingProviderKey,
        },
      },

      providersConfig: {
        provider_default: {
          baseUrl: defaultProviderBaseUrl,
          user: defaultProviderUser,
          pass: defaultProviderPass,
        },
        calendar_default: {
          calendarId: defaultCalendarId,
        },
      },
    },
  };
}
