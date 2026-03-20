import { getProviderHealth } from "./providerCircuitBreaker.js";

async function getTenantProviderHealthSummary({ tenantId, runtime }) {
  const identityProvider = String(runtime?.providers?.identity || "").trim();
  const accessProvider = String(runtime?.providers?.access || "").trim();
  const bookingProvider = String(runtime?.providers?.booking || "").trim();

  const [identity, access, booking] = await Promise.all([
    getProviderHealth({
      tenantId,
      capability: "identity",
      provider: identityProvider,
    }),
    getProviderHealth({
      tenantId,
      capability: "access",
      provider: accessProvider,
    }),
    getProviderHealth({
      tenantId,
      capability: "booking",
      provider: bookingProvider,
    }),
  ]);

  return {
    tenantId,
    identity,
    access,
    booking,
  };
}

export { getTenantProviderHealthSummary };
