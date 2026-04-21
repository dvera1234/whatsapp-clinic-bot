import { getProviderHealth } from "./providerCircuitBreaker.js";

function readString(value) {
  const v = String(value ?? "").trim();
  return v || "";
}

async function getTenantProviderHealthSummary({ tenantId, runtime }) {
  const providers = runtime?.providers && typeof runtime.providers === "object"
    ? runtime.providers
    : {};

  const entries = Object.entries(providers)
    .map(([capability, provider]) => ({
      capability: readString(capability),
      provider: readString(provider),
    }))
    .filter((item) => item.capability && item.provider);

  const results = await Promise.all(
    entries.map(async ({ capability, provider }) => {
      const health = await getProviderHealth({
        tenantId,
        capability,
        provider,
      });

      return [capability, health];
    })
  );

  return {
    tenantId,
    ...Object.fromEntries(results),
  };
}

export { getTenantProviderHealthSummary };
