import { hashText } from "../utils/crypto.js";
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

const LGPD_TEXT = `🔒 Proteção de dados (LGPD)

Para realizar o agendamento, precisamos coletar alguns dados pessoais, como CPF e informações de contato, utilizados exclusivamente para identificação do paciente e gestão do atendimento pela clínica.

Esses dados são tratados conforme a Lei Geral de Proteção de Dados (Lei nº 13.709/2018) e poderão integrar o prontuário médico quando necessário para fins assistenciais e cumprimento de obrigações legais.

Para continuar, informe se concorda com o tratamento desses dados para fins de agendamento.

📌 Responda apenas com o número da opção desejada:

1) Concordo e desejo continuar
2) Não concordo`;

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
