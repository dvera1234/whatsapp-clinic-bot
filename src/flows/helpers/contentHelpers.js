export function tpl(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => {
    const value = vars[key];
    return value == null ? "" : String(value);
  });
}

function requireText(messages, key) {
  const value = messages?.[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`TENANT_CONTENT_MISSING:${key}`);
  }
  return value;
}

function requireArray(messages, key) {
  const value = messages?.[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`TENANT_CONTENT_MISSING:${key}`);
  }
  return value;
}

function optionalText(messages, key, fallback) {
  const value = messages?.[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

export function getFlowText(runtime) {
  const messages = runtime?.content?.messages || {};

  return {
    ASK_CPF_PORTAL: requireText(messages, "askCpfPortal"),
    CPF_INVALIDO: requireText(messages, "cpfInvalido"),
    PLAN_DIVERGENCIA: requireText(messages, "planDivergencia"),
    BTN_PLAN_PRIVATE: requireText(messages, "btnPlanPrivate"),
    BTN_PLAN_INSURED: requireText(messages, "btnPlanInsured"),
    BTN_FALAR_ATENDENTE: requireText(messages, "btnFalarAtendente"),

    PORTAL_NEED_DATA: requireText(messages, "portalNeedData"),
    PORTAL_EXISTENTE_INCOMPLETO_BLOQUEIO: requireText(
      messages,
      "portalExistenteIncompletoBloqueio"
    ),

    ASK_NOME: requireText(messages, "askNome"),
    ASK_DTNASC: requireText(messages, "askDtNasc"),
    ASK_EMAIL: requireText(messages, "askEmail"),
    ASK_CEP: requireText(messages, "askCep"),
    ASK_ENDERECO: requireText(messages, "askEndereco"),
    ASK_NUMERO: requireText(messages, "askNumero"),
    ASK_COMPLEMENTO: requireText(messages, "askComplemento"),
    ASK_BAIRRO: requireText(messages, "askBairro"),
    ASK_CIDADE: requireText(messages, "askCidade"),
    ASK_UF: requireText(messages, "askUf"),

    MENU: requireText(messages, "menu"),
    LGPD_CONSENT: requireText(messages, "lgpdConsent"),
    LGPD_RECUSA: requireText(messages, "lgpdRecusa"),

    PRIVATE_MENU: requireText(messages, "privateMenu"),
    INSURANCE_MENU_TITLE: requireText(messages, "insuranceMenuTitle"),
    INSURANCE_OPTIONS: requireArray(messages, "insuranceOptions"),
    INSURANCE_INFO_1: requireText(messages, "insuranceInfo1"),
    INSURANCE_INFO_2: requireText(messages, "insuranceInfo2"),
    INSURANCE_INFO_3: requireText(messages, "insuranceInfo3"),
    INSURANCE_INFO_4: requireText(messages, "insuranceInfo4"),
    INSURED_DIRECT_MENU: requireText(messages, "insuredDirectMenu"),

    POS_MENU: requireText(messages, "posMenu"),
    POS_RECENTE: requireText(messages, "posRecente"),
    POS_TARDIO: requireText(messages, "posTardio"),
    ATENDENTE: requireText(messages, "atendente"),
    AJUDA_PERGUNTA: requireText(messages, "ajudaPergunta"),
    REDIS_UNAVAILABLE: optionalText(
      messages,
      "redisUnavailable",
      "⚠️ Não foi possível continuar o atendimento agora. Por favor, tente novamente em instantes."
    ),
    PROVIDER_UNAVAILABLE: optionalText(
      messages,
      "providerUnavailable",
      "⚠️ Nosso sistema está temporariamente indisponível no momento. Por favor, tente novamente em instantes."
    ),

    BUTTONS_ONLY_WARNING: requireText(messages, "buttonsOnlyWarning"),
    PICK_PLAN_BUTTONS_ONLY: requireText(messages, "pickPlanButtonsOnly"),

    BOOKING_SESSION_INVALID: requireText(messages, "bookingSessionInvalid"),
    BOOKING_SLOT_CONFIRM: requireText(messages, "bookingSlotConfirm"),
    BOOKING_SLOT_INVALID: requireText(messages, "bookingSlotInvalid"),
    BOOKING_PATIENT_NOT_IDENTIFIED: requireText(
      messages,
      "bookingPatientNotIdentified"
    ),
    BOOKING_ALREADY_PROCESSING: requireText(
      messages,
      "bookingAlreadyProcessing"
    ),
    BOOKING_SLOT_NOT_FOUND: requireText(messages, "bookingSlotNotFound"),
    BOOKING_SLOT_TOO_SOON: requireText(messages, "bookingSlotTooSoon"),
    BOOKING_CONFIRM_FAILURE: requireText(messages, "bookingConfirmFailure"),
    BOOKING_SUCCESS_FALLBACK: requireText(messages, "bookingSuccessFallback"),
    BOOKING_NO_DATES: requireText(messages, "bookingNoDates"),
    BOOKING_PICK_DATE: requireText(messages, "bookingPickDate"),
    BOOKING_NO_SLOTS: requireText(messages, "bookingNoSlots"),
    BOOKING_CHANGE_DATE: requireText(messages, "bookingChangeDate"),
    BOOKING_AVAILABLE_SLOTS: requireText(messages, "bookingAvailableSlots"),
    BOOKING_OPTIONS: requireText(messages, "bookingOptions"),
    BOOKING_VIEW_MORE: requireText(messages, "bookingViewMore"),

    WIZARD_NEW_PATIENT_NAME: requireText(messages, "wizardNewPatientName"),
    PROFILE_LOOKUP_FAILURE: requireText(messages, "profileLookupFailure"),
    PLAN_VALIDATION_FAILURE: requireText(messages, "planValidationFailure"),
    NAME_INVALID: requireText(messages, "nameInvalid"),
    DATE_INVALID: requireText(messages, "dateInvalid"),
    EMAIL_INVALID: requireText(messages, "emailInvalid"),
    CEP_INVALID: requireText(messages, "cepInvalid"),
    ADDRESS_INVALID: requireText(messages, "addressInvalid"),
    ADDRESS_NUMBER_INVALID: requireText(messages, "addressNumberInvalid"),
    DISTRICT_INVALID: requireText(messages, "districtInvalid"),
    CITY_INVALID: requireText(messages, "cityInvalid"),
    UF_INVALID: requireText(messages, "ufInvalid"),
    REGISTRATION_CREATE_FAILURE: requireText(
      messages,
      "registrationCreateFailure"
    ),

    ATTENDANT_DESCRIBE: requireText(messages, "attendantDescribe"),
    SUPPORT_LINK_MESSAGE: requireText(messages, "supportLinkMessage"),
    PLAN_NOT_ENABLED_MESSAGE: requireText(messages, "planNotEnabledMessage"),

    BOOKING_SUCCESS_MAIN: requireText(messages, "bookingSuccessMain"),
    PORTAL_LINK_PREFIX: requireText(messages, "portalLinkPrefix"),
    PAYMENT_INFO_PRIVATE_FIRST_VISIT: requireText(
      messages,
      "paymentInfoPrivateFirstVisit"
    ),

    SEX_PROMPT: requireText(messages, "sexPrompt"),
    SEX_MALE: requireText(messages, "sexMale"),
    SEX_FEMALE: requireText(messages, "sexFemale"),
    SEX_NO_INFO: requireText(messages, "sexNoInfo"),

    PLAN_SELECTION_PROMPT: requireText(messages, "planSelectionPrompt"),
    PLAN_OPTION_PRIVATE: requireText(messages, "planOptionPrivate"),
    PLAN_OPTION_INSURED: requireText(messages, "planOptionInsured"),

    ACTION_CONFIRM: requireText(messages, "actionConfirm"),
    ACTION_PICK_OTHER: requireText(messages, "actionPickOther"),

    INACTIVITY_CLOSED_MESSAGE: optionalText(
      messages,
      "inactivityClosedMessage",
      "✅ Atendimento encerrado por inatividade."
    ),
  };
}
