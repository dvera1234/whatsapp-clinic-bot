import { validateTenantContent } from "./validateTenantContent.js";

function readString(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function readNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
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
  return value === "versatilis";
}

function isSupportedAccessProvider(value) {
  return value === "versatilis";
}

function isSupportedBookingProvider(value) {
  return value === "versatilis" || value === "google_calendar";
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeContent(content) {
  return normalizeObject(content);
}

function normalizeProviderBlock(providerConfig = {}) {
  const source = normalizeObject(providerConfig);

  return {
    key: readString(source.key),
    baseUrl: readHttpsUrl(source.baseUrl),
    user: readString(source.user),
    pass: readString(source.pass),
    calendarId: readString(source.calendarId),
  };
}

function normalizePractitioner(practitioner = {}) {
  const source = normalizeObject(practitioner);

  return {
    practitionerId: readString(source.practitionerId),
    practitionerKey: readString(source.practitionerKey),
    label: readString(source.label),
    externalId: readNumber(source.externalId),
    specialtyId: readNumber(source.specialtyId),
    active: readBoolean(source.active),
    sortOrder: readNumber(source.sortOrder),
  };
}

function buildIdentityIntegration(provider) {
  if (provider.key === "versatilis") {
    return {
      baseUrl: provider.baseUrl,
      user: provider.user,
      pass: provider.pass,
    };
  }

  return {};
}

function buildAccessIntegration(provider) {
  if (provider.key === "versatilis") {
    return {
      baseUrl: provider.baseUrl,
      user: provider.user,
      pass: provider.pass,
    };
  }

  return {};
}

function buildBookingIntegration(provider) {
  if (provider.key === "google_calendar") {
    return {
      calendarId: provider.calendarId,
    };
  }

  if (provider.key === "versatilis") {
    return {
      baseUrl: provider.baseUrl,
      user: provider.user,
      pass: provider.pass,
    };
  }

  return {};
}

export function buildTenantRuntime(config = {}) {
  const missing = [];
  const invalid = [];

  const source = normalizeObject(config);

  const tenantId = readString(source.tenantId);

  const channels = {
    phoneNumberId: readString(source?.channels?.phoneNumberId),
  };

  const portal = {
    url: readHttpsUrl(source?.portal?.url),
  };

  const support = {
    waNumber: readDigits(source?.support?.waNumber),
  };

  const identityProvider = normalizeProviderBlock(source?.providers?.identity);
  const accessProvider = normalizeProviderBlock(source?.providers?.access);
  const bookingProvider = normalizeProviderBlock(source?.providers?.booking);

  const practitioners = Array.isArray(source.practitioners)
    ? source.practitioners.map(normalizePractitioner)
    : [];

  const content = normalizeContent(source.content);

  pushMissing(missing, !tenantId, "tenantId");
  pushMissing(missing, !channels.phoneNumberId, "channels.phoneNumberId");

  if (source?.portal?.url) {
    pushInvalid(invalid, !portal.url, "portal.url");
  }

  if (source?.support?.waNumber) {
    pushInvalid(invalid, !support.waNumber, "support.waNumber");
  }

  if (identityProvider.key) {
    pushInvalid(
      invalid,
      !isSupportedIdentityProvider(identityProvider.key),
      "providers.identity.key"
    );

    if (identityProvider.key === "versatilis") {
      pushMissing(missing, !source?.providers?.identity?.baseUrl, "providers.identity.baseUrl");
      pushMissing(missing, !identityProvider.user, "providers.identity.user");
      pushMissing(missing, !identityProvider.pass, "providers.identity.pass");

      pushInvalid(
        invalid,
        !!source?.providers?.identity?.baseUrl && !identityProvider.baseUrl,
        "providers.identity.baseUrl"
      );
    }
  }

  if (accessProvider.key) {
    pushInvalid(
      invalid,
      !isSupportedAccessProvider(accessProvider.key),
      "providers.access.key"
    );

    if (accessProvider.key === "versatilis") {
      pushMissing(missing, !source?.providers?.access?.baseUrl, "providers.access.baseUrl");
      pushMissing(missing, !accessProvider.user, "providers.access.user");
      pushMissing(missing, !accessProvider.pass, "providers.access.pass");

      pushInvalid(
        invalid,
        !!source?.providers?.access?.baseUrl && !accessProvider.baseUrl,
        "providers.access.baseUrl"
      );
    }
  }

  pushMissing(missing, !bookingProvider.key, "providers.booking.key");

  if (bookingProvider.key) {
    pushInvalid(
      invalid,
      !isSupportedBookingProvider(bookingProvider.key),
      "providers.booking.key"
    );

    if (bookingProvider.key === "versatilis") {
      pushMissing(missing, !source?.providers?.booking?.baseUrl, "providers.booking.baseUrl");
      pushMissing(missing, !bookingProvider.user, "providers.booking.user");
      pushMissing(missing, !bookingProvider.pass, "providers.booking.pass");

      pushInvalid(
        invalid,
        !!source?.providers?.booking?.baseUrl && !bookingProvider.baseUrl,
        "providers.booking.baseUrl"
      );
    }

    if (bookingProvider.key === "google_calendar") {
      pushMissing(missing, !bookingProvider.calendarId, "providers.booking.calendarId");
    }
  }

  pushMissing(missing, !Array.isArray(source.practitioners), "practitioners");

  if (Array.isArray(source.practitioners)) {
    const practitionerIds = new Set();
    const practitionerKeys = new Set();

    practitioners.forEach((practitioner, index) => {
      const basePath = `practitioners[${index}]`;

      pushMissing(missing, !practitioner.practitionerId, `${basePath}.practitionerId`);
      pushMissing(missing, !practitioner.practitionerKey, `${basePath}.practitionerKey`);
      pushMissing(missing, !practitioner.label, `${basePath}.label`);
      pushMissing(missing, practitioner.externalId === null, `${basePath}.externalId`);

      pushInvalid(
        invalid,
        !!practitioner.practitionerId && practitionerIds.has(practitioner.practitionerId),
        `${basePath}.practitionerId_duplicate`
      );

      pushInvalid(
        invalid,
        !!practitioner.practitionerKey && practitionerKeys.has(practitioner.practitionerKey),
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
        identity: identityProvider.key || null,
        access: accessProvider.key || null,
        booking: bookingProvider.key,
      },

      integrations: {
        identity: buildIdentityIntegration(identityProvider),
        access: buildAccessIntegration(accessProvider),
        booking: buildBookingIntegration(bookingProvider),
      },

      content,
    },
  };
}
