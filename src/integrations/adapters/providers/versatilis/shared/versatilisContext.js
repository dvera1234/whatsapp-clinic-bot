function getProviderRuntimeContext(runtimeCtx = {}, factoryCtx = {}) {
  const runtime =
    runtimeCtx?.runtime ||
    runtimeCtx?.tenantRuntime ||
    factoryCtx?.runtime ||
    null;

  const tenantId =
    runtimeCtx?.tenantId ||
    factoryCtx?.tenantId ||
    runtime?.tenantId ||
    null;

  return {
    tenantId,
    runtime,
    traceId: runtimeCtx?.traceId || null,
    tracePhone: runtimeCtx?.tracePhone || null,
  };
}

export { getProviderRuntimeContext };
