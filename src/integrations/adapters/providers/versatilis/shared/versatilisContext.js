function getProviderRuntimeContext(runtime = {}) {
  return {
    tenantId: runtime?.tenantId || null,
    tenantConfig: runtime?.tenantConfig || null,
    traceId: runtime?.traceId || null,
    tracePhone: runtime?.tracePhone || null,
  };
}

export { getProviderRuntimeContext };
