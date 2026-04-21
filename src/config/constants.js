import { FLOW_RESET_CODE, SESSION_TTL_SECONDS } from "./env.js";

const INACTIVITY_WARN_MS = 14 * 60 * 1000 + 50 * 1000;

// ⚠️ REMOVIDO:
// - PLAN_KEYS
// - resolvePlanIdFromRuntime
// - MIN_LEAD_HOURS (regra de negócio)
// - defaults estruturais

// ⚠️ TZ mantido como fallback técnico (não regra de negócio)
const TZ_OFFSET = "-03:00";

export {
  INACTIVITY_WARN_MS,
  TZ_OFFSET,
  FLOW_RESET_CODE,
  SESSION_TTL_SECONDS,
};
