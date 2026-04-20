import { assertSchedulingAdapter } from "../contracts/schedulingAdapter.contract.js";
import { createVersatilisSchedulingAdapter } from "../providers/versatilis/scheduling/versatilisSchedulingAdapter.js";
import { wrapAdapterWithResilience } from "../../resilience/wrapAdapterWithResilience.js";

const CAPABILITY = "booking";

const SCHEDULING_ADAPTER_BUILDERS = Object.freeze({
  versatilis: createVersatilisSchedulingAdapter,
});

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function ensureTenantId(tenantId) {
  const normalizedTenantId = readString(tenantId);

  if (!normalizedTenantId) {
    throw new Error(`FACTORY_MISSING_TENANT_ID:${CAPABILITY}`);
  }

  return normalizedTenantId;
}

function ensureRuntime(runtime) {
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    throw new Error(`FACTORY_INVALID_RUNTIME:${CAPABILITY}`);
  }

  return runtime;
}

function ensureProvider(runtime) {
  const provider = readString(runtime?.providers?.[CAPABILITY]);

  if (!provider) {
    throw new Error(`FACTORY_MISSING_PROVIDER:${CAPABILITY}`);
  }

  return provider;
}

function ensureIntegration(runtime) {
  const integration = runtime?.integrations?.[CAPABILITY];

  if (!integration || typeof integration !== "object" || Array.isArray(integration)) {
    throw new Error(`FACTORY_MISSING_INTEGRATION:${CAPABILITY}`);
  }

  return integration;
}

function resolveBuilder(provider) {
  const builder = SCHEDULING_ADAPTER_BUILDERS[provider];

  if (typeof builder !== "function") {
    throw new Error(`FACTORY_UNSUPPORTED_PROVIDER:${CAPABILITY}:${provider}`);
  }

  return builder;
}

function createSchedulingAdapter({ tenantId, runtime } = {}) {
  const safeTenantId = ensureTenantId(tenantId);
  const safeRuntime = ensureRuntime(runtime);
  const provider = ensureProvider(safeRuntime);

  ensureIntegration(safeRuntime);

  const builder = resolveBuilder(provider);

  const adapter = builder({
    tenantId: safeTenantId,
    runtime: safeRuntime,
  });

  const validatedAdapter = assertSchedulingAdapter(adapter);

  return wrapAdapterWithResilience({
    adapter: validatedAdapter,
    tenantId: safeTenantId,
    runtime: safeRuntime,
    capability: CAPABILITY,
  });
}

export { createSchedulingAdapter };
