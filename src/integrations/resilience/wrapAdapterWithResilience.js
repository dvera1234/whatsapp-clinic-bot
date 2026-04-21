import { runWithCircuitBreaker } from "./providerCircuitBreaker.js";

function isFunction(value) {
  return typeof value === "function";
}

function shouldWrapMethod(fn) {
  return isFunction(fn);
}

function wrapAdapterWithResilience({
  adapter,
  tenantId,
  runtime,
  capability,
}) {
  const provider = String(runtime?.providers?.[capability] || "").trim();

  if (!provider) {
    throw new Error(`Missing provider for capability: ${capability}`);
  }

  if (!adapter || typeof adapter !== "object") {
    throw new Error(`Invalid adapter for capability: ${capability}`);
  }

  const wrapped = {};

  for (const [key, value] of Object.entries(adapter)) {
    if (!shouldWrapMethod(value)) {
      wrapped[key] = value;
      continue;
    }

    wrapped[key] = function wrappedAdapterMethod(...args) {
      return runWithCircuitBreaker({
        tenantId,
        capability,
        provider,
        operationName: key,
        traceMeta: extractTraceMetaFromArgs(args),
        fn: () => value.apply(adapter, args),
      });
    };
  }

  return wrapped;
}

function extractTraceMetaFromArgs(args = []) {
  for (const arg of args) {
    if (!arg || typeof arg !== "object") continue;

    if (arg.traceMeta && typeof arg.traceMeta === "object") {
      return arg.traceMeta;
    }

    if (arg.runtimeCtx && typeof arg.runtimeCtx === "object") {
      return {
        traceId: arg.runtimeCtx.traceId || null,
        tracePhone: arg.runtimeCtx.tracePhone || null,
      };
    }

    if (
      Object.prototype.hasOwnProperty.call(arg, "traceId") ||
      Object.prototype.hasOwnProperty.call(arg, "tracePhone")
    ) {
      return {
        traceId: arg.traceId || null,
        tracePhone: arg.tracePhone || null,
      };
    }
  }

  return {};
}

export { wrapAdapterWithResilience };
