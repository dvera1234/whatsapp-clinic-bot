import { db } from "./index.js";

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

function readBoolean(value) {
  if (typeof value === "boolean") return value;

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }

  return false;
}

function parseJsonObject(value) {
  if (!value) return {};

  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return {};

    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }

  return {};
}

function normalizeProviderConfig(row) {
  const extraConfig = parseJsonObject(row?.extra_config_json);

  return {
    key: readString(row?.provider_key),
    baseUrl: readString(row?.base_url),
    user: readString(row?.username),
    pass: readString(row?.password_encrypted),
    ...extraConfig,
  };
}

function normalizePractitionerRow(row) {
  return {
    practitionerId: readString(row?.practitioner_id),
    practitionerKey: readString(row?.practitioner_key),
    label: readString(row?.practitioner_label),
    externalId: readNumber(row?.practitioner_external_id),
    specialtyId: readNumber(row?.practitioner_specialty_id),
    active: readBoolean(row?.practitioner_active),
    sortOrder: readNumber(row?.practitioner_sort_order),
  };
}

export async function loadTenantConfigByPhoneNumberId(phoneNumberId) {
  const safePhoneNumberId = String(phoneNumberId ?? "").trim();
  if (!safePhoneNumberId) return null;

  const sql = `
    SELECT
      t.tenant_id,
      t.name,
      t.status,

      tc.phone_number_id,

      cs.support_wa_number,
      cs.portal_url,

      p.capability,
      p.provider_key,
      p.base_url,
      p.username,
      p.password_encrypted,
      p.extra_config_json,

      tp.practitioner_id,
      tp.practitioner_key,
      tp.label AS practitioner_label,
      tp.external_id AS practitioner_external_id,
      tp.active AS practitioner_active,
      tp.sort_order AS practitioner_sort_order,
      tp.specialty_id AS practitioner_specialty_id,

      c.assistant_name,
      c.doctor_name,
      c.instagram_url,
      c.clinic_name,
      c.clinic_address_line1,
      c.clinic_address_line2,
      c.clinic_city_state_zip,
      c.post_op_recent_wa_number,
      c.messages_json

    FROM tenants t
    JOIN tenant_channels tc
      ON tc.tenant_id = t.tenant_id
    JOIN tenant_clinic_settings cs
      ON cs.tenant_id = t.tenant_id
    LEFT JOIN tenant_provider_settings p
      ON p.tenant_id = t.tenant_id
    JOIN tenant_content c
      ON c.tenant_id = t.tenant_id
    LEFT JOIN tenant_practitioners tp
      ON tp.tenant_id = t.tenant_id
    WHERE tc.phone_number_id = $1
      AND t.status = 'active'
  `;

  const { rows } = await db.query(sql, [safePhoneNumberId]);
  if (!rows.length) return null;

  const first = rows[0];

  const providers = {
    identity: null,
    access: null,
    booking: null,
  };

  const practitionersMap = new Map();

  for (const row of rows) {
    const capability = readString(row?.capability);

    if (capability === "identity" || capability === "access" || capability === "booking") {
      providers[capability] = normalizeProviderConfig(row);
    }

    const practitionerId = readString(row?.practitioner_id);
    if (practitionerId) {
      practitionersMap.set(practitionerId, normalizePractitionerRow(row));
    }
  }

  const parsedContent = parseJsonObject(first?.messages_json);

  return {
    tenantId: readString(first?.tenant_id),
    name: readString(first?.name),
    status: readString(first?.status),

    channels: {
      phoneNumberId: readString(first?.phone_number_id),
    },

    portal: {
      url: readString(first?.portal_url),
    },

    support: {
      waNumber: readString(first?.support_wa_number),
    },

    providers: {
      identity: providers.identity || {},
      access: providers.access || {},
      booking: providers.booking || {},
    },

    practitioners: Array.from(practitionersMap.values()).sort((a, b) => {
      const aOrder = Number.isFinite(a?.sortOrder) ? a.sortOrder : Number.MAX_SAFE_INTEGER;
      const bOrder = Number.isFinite(b?.sortOrder) ? b.sortOrder : Number.MAX_SAFE_INTEGER;
      return aOrder - bOrder;
    }),

    content: {
      ...parsedContent,

      branding: {
        assistantName: readString(first?.assistant_name),
        doctorName: readString(first?.doctor_name),
        instagramUrl: readString(first?.instagram_url),
      },

      clinic: {
        name: readString(first?.clinic_name),
        addressLine1: readString(first?.clinic_address_line1),
        addressLine2: readString(first?.clinic_address_line2),
        cityStateZip: readString(first?.clinic_city_state_zip),
      },

      postOp: {
        recentWaNumber: readString(first?.post_op_recent_wa_number),
      },
    },
  };
}
