import { redis } from "../../session/redisSession.js";
import { audit } from "../../observability/audit.js";

const FAILURE_THRESHOLD = 3;
const OPEN_TTL_SECONDS = 60;
const HEALTH_TTL_SECONDS = 120;

function normalizeProviderName(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeCapability(value) {
  return String(value || "").trim().toLowerCase();
}

function buildBreakerKey({ tenantId, capability, provider }) {
  const t = String(tenantId || "").trim();
  const c = normalizeCapability(capability);
  const p = normalizeProviderName(provider);
  return `cb:${t}:${c}:${p}`;
}

function buildHealthKey({ tenantId, capability, provider }) {
  const t = String(tenantId || "").trim();
  const c = normalizeCapability(capability);
  const p = normalizeProviderName(provider);
  return `health:${t}:${c}:${p}`;
}

function buildFailureCounterKey({ tenantId, capability, provider }) {
  const t = String(tenantId || "").trim();
  const c = normalizeCapability(capability);
  const p = normalizeProviderName(provider);
  return `cbfail:${t}:${c}:${p}`;
}

function isRetryableError(error) {
  const msg = String(error?.message || error || "").toLowerCase();

  return (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("504")
  );
}

async function getBreakerState({ tenantId, capability, provider }) {
  const key = buildBreakerKey({ tenantId, capability, provider });

  try {
    const value = await redis.get(key);
    return value ? String(value) : "closed";
  } catch {
    return "closed";
  }
}

async function openCircuit({
  tenantId,
  capability,
  provider,
  traceMeta = {},
  reason = "provider_failure_threshold_reached",
}) {
  const breakerKey = buildBreakerKey({ tenantId, capability, provider });
  const failureKey = buildFailureCounterKey({ tenantId, capability, provider });

  try {
    await redis.set(breakerKey, reason, { ex: OPEN_TTL_SECONDS });
    await redis.del(failureKey).catch(() => {});
  } catch {}

  audit("PROVIDER_CIRCUIT_OPENED", {
    tenantId,
    capability,
    provider,
    ...traceMeta,
    reason,
    openTtlSeconds: OPEN_TTL_SECONDS,
  });
}

async function closeCircuit({ tenantId, capability, provider, traceMeta = {} }) {
  const breakerKey = buildBreakerKey({ tenantId, capability, provider });
  const failureKey = buildFailureCounterKey({ tenantId, capability, provider });

  try {
    await redis.del(breakerKey).catch(() => {});
    await redis.del(failureKey).catch(() => {});
  } catch {}

  audit("PROVIDER_CIRCUIT_CLOSED", {
    tenantId,
    capability,
    provider,
    ...traceMeta,
  });
}

async function registerSuccess({
  tenantId,
  capability,
  provider,
  traceMeta = {},
}) {
  const healthKey = buildHealthKey({ tenantId, capability, provider });
  const failureKey = buildFailureCounterKey({ tenantId, capability, provider });

  try {
    await redis.set(
      healthKey,
      JSON.stringify({
        status: "healthy",
        ts: new Date().toISOString(),
      }),
      { ex: HEALTH_TTL_SECONDS }
    );

    await redis.del(failureKey).catch(() => {});
  } catch {}

async function registerFailure({
  tenantId,
  capability,
  provider,
  traceMeta = {},
  error,
}) {
  const failureKey = buildFailureCounterKey({ tenantId, capability, provider });
  const healthKey = buildHealthKey({ tenantId, capability, provider });

  let count = 1;

  try {
    count = await redis.incr(failureKey);
    if (count === 1) {
      await redis.expire(failureKey, OPEN_TTL_SECONDS);
    }

    await redis.set(
      healthKey,
      JSON.stringify({
        status: "degraded",
        ts: new Date().toISOString(),
        error: String(error?.message || error || "unknown_error").slice(0, 300),
      }),
      { ex: HEALTH_TTL_SECONDS }
    );
  } catch {}

  audit("PROVIDER_CALL_FAILED", {
    tenantId,
    capability,
    provider,
    ...traceMeta,
    failureCount: count,
    error: String(error?.message || error || "unknown_error"),
    retryable: isRetryableError(error),
  });

  if (count >= FAILURE_THRESHOLD && isRetryableError(error)) {
    await openCircuit({
      tenantId,
      capability,
      provider,
      traceMeta,
      reason: "retryable_failure_threshold_reached",
    });
  }
}

async function assertCircuitClosed({
  tenantId,
  capability,
  provider,
  traceMeta = {},
}) {
  const state = await getBreakerState({ tenantId, capability, provider });

  if (state !== "closed") {
    audit("PROVIDER_CIRCUIT_BLOCKED_CALL", {
      tenantId,
      capability,
      provider,
      ...traceMeta,
      breakerState: state,
    });

    const error = new Error(
      `Provider temporarily unavailable: ${capability}/${provider}`
    );
    error.code = "PROVIDER_CIRCUIT_OPEN";
    throw error;
  }
}

async function runWithCircuitBreaker({
  tenantId,
  capability,
  provider,
  traceMeta = {},
  operationName,
  fn,
}) {
  await assertCircuitClosed({
    tenantId,
    capability,
    provider,
    traceMeta: {
      ...traceMeta,
      operationName,
    },
  });

  try {
    const result = await fn();

    await registerSuccess({
      tenantId,
      capability,
      provider,
      traceMeta: {
        ...traceMeta,
        operationName,
      },
    });

    return result;
  } catch (error) {
    await registerFailure({
      tenantId,
      capability,
      provider,
      traceMeta: {
        ...traceMeta,
        operationName,
      },
      error,
    });

    throw error;
  }
}

async function getProviderHealth({ tenantId, capability, provider }) {
  const state = await getBreakerState({ tenantId, capability, provider });
  const healthKey = buildHealthKey({ tenantId, capability, provider });

  let lastHealth = null;

  try {
    const raw = await redis.get(healthKey);
    lastHealth = raw ? JSON.parse(raw) : null;
  } catch {
    lastHealth = null;
  }

  return {
    tenantId,
    capability,
    provider,
    circuitState: state,
    lastHealth,
  };
}

export {
  runWithCircuitBreaker,
  getProviderHealth,
  getBreakerState,
  openCircuit,
  closeCircuit,
};
