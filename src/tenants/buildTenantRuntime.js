export function buildTenantRuntime(config = {}) {
  const identity = config.providers?.identity;
  const access = config.providers?.access;
  const booking = config.providers?.booking;

  if (!identity || !identity.baseUrl) {
    return { ok: false, missing: ["providers.identity"] };
  }

  return {
    ok: true,
    value: {
      tenantId: config.tenantId,

      clinic: {
        primaryPractitionerId: config.clinic.codColaborador,
        defaultUnitId: config.clinic.codUnidade,
        defaultSpecialtyId: config.clinic.codEspecialidade,
      },

      plans: {
        privatePlanId: config.plans.codPlanoParticular,
        insuredPlanId: config.plans.codPlanoMedSeniorSp,
      },

      portal: {
        url: config.portal.url,
      },

      support: {
        waNumber: config.support.waNumber,
      },

      providers: {
        identity: identity.key,
        access: access?.key,
        booking: booking?.key,
      },

      integrations: {
        identity,
        access,
        booking,
      },
    },
  };
}
