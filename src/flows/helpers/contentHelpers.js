export function tpl(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => {
    const value = vars[key];
    return value == null ? "" : String(value);
  });
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`TENANT_CONTENT_MISSING:${fieldName}`);
  }
  return value;
}

export function getMenu(runtime) {
  const menu = runtime?.content?.menu;

  if (!menu || typeof menu !== "object") {
    throw new Error("TENANT_CONTENT_MISSING:menu");
  }

  requireNonEmptyString(menu.text, "menu.text");

  if (!Array.isArray(menu.options)) {
    throw new Error("TENANT_CONTENT_MISSING:menu.options");
  }

  return menu;
}

export function getPlans(runtime) {
  const plans = runtime?.content?.plans;

  if (!Array.isArray(plans)) {
    throw new Error("TENANT_CONTENT_MISSING:plans");
  }

  return plans;
}

export function getPlanById(runtime, planId) {
  return (
    getPlans(runtime).find(
      (plan) => String(plan?.id || "") === String(planId || "")
    ) || null
  );
}

export function getMessages(runtime) {
  const messages = runtime?.content?.messages;

  if (!messages || typeof messages !== "object") {
    throw new Error("TENANT_CONTENT_MISSING:messages");
  }

  return messages;
}

export function getMessage(runtime, key, fallback = "") {
  const messages = getMessages(runtime);
  const value = messages?.[key];

  if (typeof value === "string" && value.trim()) {
    return value;
  }

  return fallback;
}

export function requireMessage(runtime, key) {
  return requireNonEmptyString(getMessages(runtime)?.[key], `messages.${key}`);
}

export function getFlowDefinition(runtime, flowKey) {
  const flows = runtime?.content?.flows;

  if (!flows || typeof flows !== "object") {
    throw new Error("TENANT_CONTENT_MISSING:flows");
  }

  const flow = flows?.[flowKey];

  if (!flow || typeof flow !== "object") {
    throw new Error(`TENANT_CONTENT_MISSING:flows.${flowKey}`);
  }

  return flow;
}

export function getFlowText(runtime) {
  return {
    ASK_CPF_PORTAL: requireMessage(runtime, "askCpfPortal"),
    CPF_INVALIDO: requireMessage(runtime, "cpfInvalido"),
    PLAN_DIVERGENCIA: requireMessage(runtime, "planDivergencia"),
    BTN_PLAN_PRIVATE: requireMessage(runtime, "btnPlanPrivate"),
    BTN_PLAN_INSURED: requireMessage(runtime, "btnPlanInsured"),
    BTN_FALAR_ATENDENTE: requireMessage(runtime, "btnFalarAtendente"),

    PORTAL_NEED_DATA: requireMessage(runtime, "portalNeedData"),
    PORTAL_EXISTENTE_INCOMPLETO_BLOQUEIO: requireMessage(
      runtime,
      "portalExistenteIncompletoBloqueio"
    ),

    ASK_NOME: requireMessage(runtime, "askNome"),
    ASK_DTNASC: requireMessage(runtime, "askDtNasc"),
    ASK_EMAIL: requireMessage(runtime, "askEmail"),
    ASK_CEP: requireMessage(runtime, "askCep"),
    ASK_ENDERECO: requireMessage(runtime, "askEndereco"),
    ASK_NUMERO: requireMessage(runtime, "askNumero"),
    ASK_COMPLEMENTO: requireMessage(runtime, "askComplemento"),
    ASK_BAIRRO: requireMessage(runtime, "askBairro"),
    ASK_CIDADE: requireMessage(runtime, "askCidade"),
    ASK_UF: requireMessage(runtime, "askUf"),

    MENU: getMenu(runtime).text,
    LGPD_CONSENT: requireMessage(runtime, "lgpdConsent"),
    LGPD_RECUSA: requireMessage(runtime, "lgpdRecusa"),

    BUTTONS_ONLY_WARNING: requireMessage(runtime, "buttonsOnlyWarning"),
    PICK_PLAN_BUTTONS_ONLY: requireMessage(runtime, "pickPlanButtonsOnly"),

    BOOKING_SESSION_INVALID: requireMessage(runtime, "bookingSessionInvalid"),
    BOOKING_SLOT_CONFIRM: requireMessage(runtime, "bookingSlotConfirm"),
    BOOKING_SLOT_INVALID: requireMessage(runtime, "bookingSlotInvalid"),
    BOOKING_PATIENT_NOT_IDENTIFIED: requireMessage(
      runtime,
      "bookingPatientNotIdentified"
    ),
    BOOKING_ALREADY_PROCESSING: requireMessage(
      runtime,
      "bookingAlreadyProcessing"
    ),
    BOOKING_SLOT_NOT_FOUND: requireMessage(runtime, "bookingSlotNotFound"),
    BOOKING_SLOT_TOO_SOON: requireMessage(runtime, "bookingSlotTooSoon"),
    BOOKING_CONFIRM_FAILURE: requireMessage(runtime, "bookingConfirmFailure"),
    BOOKING_SUCCESS_FALLBACK: requireMessage(runtime, "bookingSuccessFallback"),
    BOOKING_NO_DATES: requireMessage(runtime, "bookingNoDates"),
    BOOKING_PICK_DATE: requireMessage(runtime, "bookingPickDate"),
    BOOKING_NO_SLOTS: requireMessage(runtime, "bookingNoSlots"),
    BOOKING_CHANGE_DATE: requireMessage(runtime, "bookingChangeDate"),
    BOOKING_AVAILABLE_SLOTS: requireMessage(runtime, "bookingAvailableSlots"),
    BOOKING_OPTIONS: requireMessage(runtime, "bookingOptions"),
    BOOKING_VIEW_MORE: requireMessage(runtime, "bookingViewMore"),

    WIZARD_NEW_PATIENT_NAME: requireMessage(runtime, "wizardNewPatientName"),
    PROFILE_LOOKUP_FAILURE: requireMessage(runtime, "profileLookupFailure"),
    PLAN_VALIDATION_FAILURE: requireMessage(runtime, "planValidationFailure"),
    NAME_INVALID: requireMessage(runtime, "nameInvalid"),
    DATE_INVALID: requireMessage(runtime, "dateInvalid"),
    EMAIL_INVALID: requireMessage(runtime, "emailInvalid"),
    CEP_INVALID: requireMessage(runtime, "cepInvalid"),
    ADDRESS_INVALID: requireMessage(runtime, "addressInvalid"),
    ADDRESS_NUMBER_INVALID: requireMessage(runtime, "addressNumberInvalid"),
    DISTRICT_INVALID: requireMessage(runtime, "districtInvalid"),
    CITY_INVALID: requireMessage(runtime, "cityInvalid"),
    UF_INVALID: requireMessage(runtime, "ufInvalid"),
    REGISTRATION_CREATE_FAILURE: requireMessage(
      runtime,
      "registrationCreateFailure"
    ),

    ATTENDANT_DESCRIBE: requireMessage(runtime, "attendantDescribe"),
    SUPPORT_LINK_MESSAGE: requireMessage(runtime, "supportLinkMessage"),
    PLAN_NOT_ENABLED_MESSAGE: requireMessage(runtime, "planNotEnabledMessage"),

    BOOKING_SUCCESS_MAIN: requireMessage(runtime, "bookingSuccessMain"),
    PORTAL_LINK_PREFIX: requireMessage(runtime, "portalLinkPrefix"),
    PAYMENT_INFO_PRIVATE_FIRST_VISIT: requireMessage(
      runtime,
      "paymentInfoPrivateFirstVisit"
    ),

    SEX_PROMPT: requireMessage(runtime, "sexPrompt"),
    SEX_MALE: requireMessage(runtime, "sexMale"),
    SEX_FEMALE: requireMessage(runtime, "sexFemale"),
    SEX_NO_INFO: requireMessage(runtime, "sexNoInfo"),

    PLAN_SELECTION_PROMPT: requireMessage(runtime, "planSelectionPrompt"),
    PLAN_OPTION_PRIVATE: requireMessage(runtime, "planOptionPrivate"),
    PLAN_OPTION_INSURED: requireMessage(runtime, "planOptionInsured"),

    ACTION_CONFIRM: requireMessage(runtime, "actionConfirm"),
    ACTION_PICK_OTHER: requireMessage(runtime, "actionPickOther"),

    REDIS_UNAVAILABLE: getMessage(
      runtime,
      "redisUnavailable",
      "⚠️ Não foi possível continuar o atendimento agora. Por favor, tente novamente em instantes."
    ),
    PROVIDER_UNAVAILABLE: getMessage(
      runtime,
      "providerUnavailable",
      "⚠️ Nosso sistema está temporariamente indisponível no momento. Por favor, tente novamente em instantes."
    ),
    INACTIVITY_CLOSED_MESSAGE: getMessage(
      runtime,
      "inactivityClosedMessage",
      "✅ Atendimento encerrado por inatividade."
    ),
  };
}
