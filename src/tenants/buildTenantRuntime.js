import { validateTenantContent } from "./validateTenantContent.js";

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

function readBoolean(value) {
  if (typeof value === "boolean") return value;

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }

  return false;
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
  return content && typeof content === "object" && !Array.isArray(content)
    ? content
    : {};
}

function normalizeProviderBlock(providerConfig = {}) {
  return {
    key: readString(providerConfig.key),
    baseUrl: readHttpsUrl(providerConfig.baseUrl),
    user: readString(providerConfig.user),
    pass: readString(providerConfig.pass),
    calendarId: readString(providerConfig.calendarId),
  };
}

function normalizePractitioner(practitioner = {}) {
  return {
    practitionerId: readString(practitioner.practitionerId),
    practitionerKey: readString(practitioner.practitionerKey),
    label: readString(practitioner.label),
    externalId: readNumber(practitioner.externalId),
    specialtyId: readNumber(practitioner.specialtyId),
    active: readBoolean(practitioner.active),
    sortOrder: readNumber(practitioner.sortOrder),
  };
}

export function buildTenantRuntime(config = {}) {
  const missing = [];
  const invalid = [];

  const tenantId = readString(config?.tenantId);

  const channels = {
    phoneNumberId: readString(config?.channels?.phoneNumberId),
  };

  const portal = {
    url: readHttpsUrl(config?.portal?.url),
  };

  const support = {
    waNumber: readDigits(config?.support?.waNumber),
  };

  const identity = normalizeProviderBlock(config?.providers?.identity);
  const access = normalizeProviderBlock(config?.providers?.access);
  const booking = normalizeProviderBlock(config?.providers?.booking);

  const practitioners = Array.isArray(config?.practitioners)
    ? config.practitioners.map(normalizePractitioner)
    : [];

  const content = normalizeContent(config?.content);

  pushMissing(missing, !tenantId, "tenantId");
  pushMissing(missing, !channels.phoneNumberId, "channels.phoneNumberId");

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
  }

  if (booking.key === "google_calendar") {
    pushMissing(missing, !booking.calendarId, "providers.booking.calendarId");
  }

  pushMissing(
    missing,
    !Array.isArray(config?.practitioners),
    "practitioners"
  );

  if (Array.isArray(config?.practitioners)) {
    const practitionerIds = new Set();
    const practitionerKeys = new Set();

    practitioners.forEach((practitioner, index) => {
      const basePath = `practitioners[${index}]`;

      pushMissing(
        missing,
        !practitioner.practitionerId,
        `${basePath}.practitionerId`
      );
      pushMissing(
        missing,
        !practitioner.practitionerKey,
        `${basePath}.practitionerKey`
      );
      pushMissing(missing, !practitioner.label, `${basePath}.label`);
      pushMissing(
        missing,
        practitioner.externalId === null,
        `${basePath}.externalId`
      );

      pushInvalid(
        invalid,
        practitionerIds.has(practitioner.practitionerId),
        `${basePath}.practitionerId_duplicate`
      );
      pushInvalid(
        invalid,
        practitionerKeys.has(practitioner.practitionerKey),
        `${basePath}.practitionerKey_duplicate`
      );

      if (practitioner.practitionerId) {
        practitionerIds.add(practitioner.practitionerId);
      }

      if (practitioner.practitionerKey) {
        practitionerKeys.add(practitioner.practitionerKey);
      }
    });
  }

  const contentValidation = validateTenantContent(content, { practitioners });

  if (!contentValidation.ok) {
    invalid.push(...contentValidation.errors.map((field) => `content.${field}`));
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

      channels,

      portal,

      support,

      practitioners,

      providers: {
        identity: identity.key,
        access: access.key,
        booking: booking.key,
      },

      integrations: {
        identity:
          identity.key === "versatilis"
            ? {
                key: identity.key,
                baseUrl: identity.baseUrl,
                user: identity.user,
                pass: identity.pass,
              }
            : {
                key: identity.key,
              },

        access:
          access.key === "versatilis"
            ? {
                key: access.key,
                baseUrl: access.baseUrl,
                user: access.user,
                pass: access.pass,
              }
            : {
                key: access.key,
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
              },
      },

      content,
    },
  };
}
