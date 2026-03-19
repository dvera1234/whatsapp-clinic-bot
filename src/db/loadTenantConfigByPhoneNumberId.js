import { db } from "./index.js";

export async function loadTenantConfigByPhoneNumberId(phoneNumberId) {
  const sql = `
    SELECT
      t.tenant_id,
      t.name,
      t.status,

      tc.phone_number_id,
      tc.whatsapp_business_account_id,

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
      p.extra_config_json

    FROM tenants t
    JOIN tenant_channels tc
      ON tc.tenant_id = t.tenant_id
    JOIN tenant_clinic_settings cs
      ON cs.tenant_id = t.tenant_id
    JOIN tenant_plan_settings ps
      ON ps.tenant_id = t.tenant_id
    JOIN tenant_provider_settings p
      ON p.tenant_id = t.tenant_id
    WHERE tc.phone_number_id = $1
      AND t.status = 'active'
    ORDER BY p.capability ASC
  `;

  const { rows } = await db.query(sql, [String(phoneNumberId)]);

  if (!rows.length) {
    return null;
  }

  const first = rows[0];

  const providersByCapability = {};
  for (const row of rows) {
    providersByCapability[row.capability] = {
      providerKey: row.provider_key,
      baseUrl: row.base_url,
      username: row.username,
      passwordEncrypted: row.password_encrypted,
      extraConfig: row.extra_config_json || {},
    };
  }

  const identityProvider = providersByCapability.identity || null;
  const accessProvider = providersByCapability.access || null;
  const bookingProvider = providersByCapability.booking || null;

  const defaultVersatilisProvider =
    identityProvider || accessProvider || bookingProvider || null;

  return {
    tenantId: first.tenant_id,
    name: first.name,
    status: first.status,

    channels: {
      phoneNumberId: first.phone_number_id,
      whatsappBusinessAccountId: first.whatsapp_business_account_id,
    },

    clinic: {
      codUnidade: first.default_unit_id,
      codEspecialidade: first.default_specialty_id,
      codColaborador: first.primary_practitioner_id,
    },

    plans: {
      codPlanoParticular: first.private_plan_id,
      codPlanoMedSeniorSp: first.insured_plan_id,
    },

    portal: {
      url: first.portal_url,
    },

    support: {
      waNumber: first.support_wa_number,
    },

    integrations: {
      patientProvider: identityProvider?.providerKey || null,
      portalProvider: accessProvider?.providerKey || null,
      schedulingProvider: bookingProvider?.providerKey || null,

      versatilis: {
        baseUrl: defaultVersatilisProvider?.baseUrl || "",
        user: defaultVersatilisProvider?.username || "",
        pass: defaultVersatilisProvider?.passwordEncrypted || "",
      },

      googleCalendar: {
        calendarId:
          bookingProvider?.extraConfig?.calendarId ||
          bookingProvider?.extraConfig?.calendar_id ||
          "",
      },
    },
  };
}
