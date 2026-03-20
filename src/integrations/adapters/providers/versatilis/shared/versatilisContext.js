function getProviderRuntimeContext(runtimeCtx = {}) {
  const runtime =
    runtimeCtx?.runtime ||
    runtimeCtx?.tenantRuntime ||
    runtimeCtx ||
    null;

  return {
    tenantId: runtime?.tenantId || null,
    runtime,
    traceId: runtimeCtx?.traceId || runtime?.traceId || null,
    tracePhone: runtimeCtx?.tracePhone || runtime?.tracePhone || null,
  };
}

export { getProviderRuntimeContext };
