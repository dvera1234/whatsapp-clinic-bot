import { FLOW_RESET_CODE, SESSION_TTL_SECONDS } from "./env.js";

const INACTIVITY_WARN_MS = 14 * 60 * 1000 + 50 * 1000;
const MIN_LEAD_HOURS = 12;
const TZ_OFFSET = "-03:00";

const PLAN_KEYS = {
  PRIVATE: "PRIVATE",
  INSURED: "INSURED",
};

function resolvePlanIdFromRuntime(planKey, runtime) {
  if (!runtime?.plans) return null;

  return planKey === PLAN_KEYS.INSURED
    ? runtime.plans.insuredPlanId
    : runtime.plans.privatePlanId;
}

export {
  INACTIVITY_WARN_MS,
  MIN_LEAD_HOURS,
  TZ_OFFSET,
  PLAN_KEYS,
  resolvePlanIdFromRuntime,
  FLOW_RESET_CODE,
  SESSION_TTL_SECONDS,
};
