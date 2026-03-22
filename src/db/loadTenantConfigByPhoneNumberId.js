import { db } from "./index.js";

export async function loadTenantConfigByPhoneNumberId(phoneNumberId) {
  const sql = `
    SELECT
      t.tenant_id,
      t.name,
      t.status,

      tc.phone_number_id,

      cs.default_unit_id,
      cs.default_specialty_id,
      cs.primary_practitioner_id,
      cs.support_wa_number,
      cs.portal_url,

      ps.private_plan_id,
      ps.insured_plan_id,

      p.capability,
      p.provider_key,
      p.base_url,
      p.username,
      p.password_encrypted,
      p.extra_config_json,

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
    JOIN tenant_channels tc ON tc.tenant_id = t.tenant_id
    JOIN tenant_clinic_settings cs ON cs.tenant_id = t.tenant_id
    JOIN tenant_plan_settings ps ON ps.tenant_id = t.tenant_id
    JOIN tenant_provider_settings p ON p.tenant_id = t.tenant_id
    JOIN tenant_content c ON c.tenant_id = t.tenant_id
    WHERE tc.phone_number_id = $1
      AND t.status = 'active'
  `;

  const { rows } = await db.query(sql, [String(phoneNumberId)]);
  if (!rows.length) return null;

  const first = rows[0];

  const providers = {
    identity: null,
    access: null,
    booking: null,
  };

  for (const row of rows) {
    const capability = String(row.capability || "").trim();
    if (!capability) continue;

    providers[capability] = {
      key: row.provider_key || "",
      baseUrl: row.base_url || "",
      user: row.username || "",
      pass: row.password_encrypted || "",
      ...(row.extra_config_json && typeof row.extra_config_json === "object"
        ? row.extra_config_json
        : {}),
    };
  }

  return {
    tenantId: first.tenant_id,

    clinic: {
      providerId: first.primary_practitioner_id,
    },

    bookingDefaults: {
      unitId: first.default_unit_id,
      specialtyId: first.default_specialty_id,
    },

    planMappings: {
      PRIVATE: {
        externalId: first.private_plan_id,
      },
      INSURED: {
        externalId: first.insured_plan_id,
      },
    },

    portal: {
      url: first.portal_url || "",
    },

    support: {
      waNumber: first.support_wa_number || "",
    },

    providers: {
      identity: {
        key: providers.identity?.key || "",
        baseUrl: providers.identity?.baseUrl || "",
        user: providers.identity?.user || "",
        pass: providers.identity?.pass || "",
      },
      access: {
        key: providers.access?.key || "",
        baseUrl: providers.access?.baseUrl || "",
        user: providers.access?.user || "",
        pass: providers.access?.pass || "",
      },
      booking: {
        key: providers.booking?.key || "",
        baseUrl: providers.booking?.baseUrl || "",
        user: providers.booking?.user || "",
        pass: providers.booking?.pass || "",
        calendarId: providers.booking?.calendarId || "",
      },
    },

    content: {
      branding: {
        assistantName: first.assistant_name || "",
        doctorName: first.doctor_name || "",
        instagramUrl: first.instagram_url || "",
      },

      clinic: {
        name: first.clinic_name || "",
        addressLine1: first.clinic_address_line1 || "",
        addressLine2: first.clinic_address_line2 || "",
        cityStateZip: first.clinic_city_state_zip || "",
      },

      postOp: {
        recentWaNumber: first.post_op_recent_wa_number || "",
      },

      messages:
        first.messages_json && typeof first.messages_json === "object"
          ? first.messages_json
          : {},
    },
  };
}
