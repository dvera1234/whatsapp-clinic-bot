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
  return ["versatilis"].includes(value);
}

function isSupportedAccessProvider(value) {
  return ["versatilis"].includes(value);
}

function isSupportedBookingProvider(value) {
  return ["versatilis", "google_calendar"].includes(value);
}

export function buildTenantRuntime(tenantConfig = {}) {
  const tenantId = readString(tenantConfig?.tenantId);

  const identityProvider = readString(
    tenantConfig?.integrations?.identityProvider || "versatilis"
  );

  const accessProvider = readString(
    tenantConfig?.integrations?.accessProvider || "versatilis"
  );

  const bookingProvider = readString(
    tenantConfig?.integrations?.bookingProvider || "versatilis"
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

  const versatilisBaseUrl = readString(
    tenantConfig?.integrations?.versatilis?.baseUrl
  );
  const versatilisUser = readString(
    tenantConfig?.integrations?.versatilis?.user
  );
  const versatilisPass = readString(
    tenantConfig?.integrations?.versatilis?.pass
  );

  const googleCalendarId = readString(
    tenantConfig?.integrations?.googleCalendar?.calendarId
  );

  const missing = [];
  const invalid = [];

  pushIfMissing(missing, !tenantId, "tenantId");

  if (!isSupportedIdentityProvider(identityProvider)) {
    invalid.push("integrations.identityProvider");
  }

  if (!isSupportedAccessProvider(accessProvider)) {
    invalid.push("integrations.accessProvider");
  }

  if (!isSupportedBookingProvider(bookingProvider)) {
    invalid.push("integrations.bookingProvider");
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

  const needsVersatilis =
    identityProvider === "versatilis" ||
    accessProvider === "versatilis" ||
    bookingProvider === "versatilis";

  if (needsVersatilis) {
    pushIfMissing(
      missing,
      !versatilisBaseUrl,
      "integrations.versatilis.baseUrl"
    );
    pushIfMissing(
      missing,
      !versatilisUser,
      "integrations.versatilis.user"
    );
    pushIfMissing(
      missing,
      !versatilisPass,
      "integrations.versatilis.pass"
    );
  }

  if (bookingProvider === "google_calendar") {
    pushIfMissing(
      missing,
      !googleCalendarId,
      "integrations.googleCalendar.calendarId"
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
        identityProvider,
        accessProvider,
        bookingProvider,
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

      integrations: {
        identity: {
          provider: identityProvider,
        },
        access: {
          provider: accessProvider,
        },
        booking: {
          provider: bookingProvider,
        },
        versatilis: {
          baseUrl: versatilisBaseUrl,
          user: versatilisUser,
          pass: versatilisPass,
        },
        googleCalendar: {
          calendarId: googleCalendarId,
        },
      },
    },
  };
}
