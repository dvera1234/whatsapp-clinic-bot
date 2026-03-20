export function buildTenantRuntime(config = {}) {
  const identity = config.providers?.identity;
  const access = config.providers?.access;
  const booking = config.providers?.booking;

  const missing = [];

  if (!identity?.key) missing.push("providers.identity.key");
  if (!identity?.baseUrl) missing.push("providers.identity.baseUrl");

  if (!access?.key) missing.push("providers.access.key");
  if (!access?.baseUrl) missing.push("providers.access.baseUrl");

  if (!booking?.key) missing.push("providers.booking.key");
  if (!booking?.baseUrl) missing.push("providers.booking.baseUrl");

  if (missing.length) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    value: {
      tenantId: config.tenantId,

      clinic: {
        primaryPractitionerId: config.clinic?.codColaborador ?? null,
        defaultUnitId: config.clinic?.codUnidade ?? null,
        defaultSpecialtyId: config.clinic?.codEspecialidade ?? null,
      },

      plans: {
        privatePlanId: config.plans?.codPlanoParticular ?? null,
        insuredPlanId: config.plans?.codPlanoMedSeniorSp ?? null,
      },

      portal: {
        url: config.portal?.url || "",
      },

      support: {
        waNumber: config.support?.waNumber || "",
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

      // 🔥 NOVO
      content: config.content || {},
    },
  };
}
