import { hashText } from "../utils/crypto.js";
import { FLOW_RESET_CODE, SESSION_TTL_SECONDS } from "./env.js";

const INACTIVITY_WARN_MS = 14 * 60 * 1000 + 50 * 1000;
const MIN_LEAD_HOURS = 12;
const TZ_OFFSET = "-03:00";

const PLAN_KEYS = {
  PARTICULAR: "PARTICULAR",
  MEDSENIOR_SP: "MEDSENIOR_SP",
};

function resolvePlanIdFromRuntime(planKey, runtime) {
  if (!runtime?.plans) return null;

  return planKey === PLAN_KEYS.MEDSENIOR_SP
    ? runtime.plans.insuredPlanId
    : runtime.plans.privatePlanId;
}

// 🔥 LGPD agora vira padrão técnico (não conteúdo de clínica)
const LGPD_TEXT = `🔒 Proteção de dados (LGPD)...`;

const LGPD_TEXT_VERSION = "LGPD_v1";
const LGPD_TEXT_HASH = hashText(LGPD_TEXT);

export {
  INACTIVITY_WARN_MS,
  MIN_LEAD_HOURS,
  TZ_OFFSET,
  PLAN_KEYS,
  resolvePlanIdFromRuntime,
  LGPD_TEXT,
  LGPD_TEXT_VERSION,
  LGPD_TEXT_HASH,
  FLOW_RESET_CODE,
  SESSION_TTL_SECONDS,
};
