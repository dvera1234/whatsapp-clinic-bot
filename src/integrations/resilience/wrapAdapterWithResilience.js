import { runWithCircuitBreaker } from "./providerCircuitBreaker.js";

function isAsyncFunction(fn) {
  return typeof fn === "function" && fn.constructor?.name === "AsyncFunction";
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
    if (typeof value !== "function") {
      wrapped[key] = value;
      continue;
    }

    if (!isAsyncFunction(value)) {
      wrapped[key] = value.bind(adapter);
      continue;
    }

    wrapped[key] = async function wrappedAdapterMethod(...args) {
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
