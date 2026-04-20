function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function ensureObject(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`TENANT_CONTENT_MISSING:${fieldName}`);
  }
  return value;
}

function ensureNonEmptyString(value, fieldName) {
  const normalized = readString(value);
  if (!normalized) {
    throw new Error(`TENANT_CONTENT_MISSING:${fieldName}`);
  }
  return normalized;
}

function ensureArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new Error(`TENANT_CONTENT_MISSING:${fieldName}`);
  }
  return value;
}

export function tpl(template, vars = {}) {
  const source = String(template ?? "");

  return source.replace(/\{(\w+)\}/g, (_, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      return "";
    }

    const value = vars[key];
    return value == null ? "" : String(value);
  });
}

export function getContent(runtime) {
  return ensureObject(runtime?.content, "content");
}

export function getMenu(runtime) {
  const menu = ensureObject(getContent(runtime)?.menu, "menu");

  ensureNonEmptyString(menu.text, "menu.text");
  ensureArray(menu.options, "menu.options");

  return menu;
}

export function getPlans(runtime) {
  return ensureArray(getContent(runtime)?.plans, "plans");
}

export function getPlanById(runtime, planId) {
  const normalizedPlanId = String(planId ?? "").trim();

  return (
    getPlans(runtime).find(
      (plan) => String(plan?.id ?? "").trim() === normalizedPlanId
    ) || null
  );
}

export function getPlanByKey(runtime, planKey) {
  const normalizedPlanKey = readString(planKey);

  return (
    getPlans(runtime).find(
      (plan) => readString(plan?.key) === normalizedPlanKey
    ) || null
  );
}

export function getMessages(runtime) {
  return ensureObject(getContent(runtime)?.messages, "messages");
}

export function getMessage(runtime, key, fallback = "") {
  const normalizedKey = readString(key);
  if (!normalizedKey) {
    return readString(fallback);
  }

  const value = getMessages(runtime)?.[normalizedKey];
  return readString(value) || readString(fallback);
}

export function requireMessage(runtime, key) {
  const normalizedKey = readString(key);
  return ensureNonEmptyString(
    getMessages(runtime)?.[normalizedKey],
    `messages.${normalizedKey}`
  );
}

export function getFlows(runtime) {
  return ensureObject(getContent(runtime)?.flows, "flows");
}

export function getFlowDefinition(runtime, flowKey) {
  const normalizedFlowKey = readString(flowKey);
  const flows = getFlows(runtime);

  const flow = flows?.[normalizedFlowKey];
  return ensureObject(flow, `flows.${normalizedFlowKey}`);
}

export function getDispatch(runtime) {
  return ensureObject(getContent(runtime)?.dispatch, "dispatch");
}

export function getWizard(runtime) {
  return ensureObject(getContent(runtime)?.wizard, "wizard");
}

export function getWizardFieldMap(runtime) {
  const wizard = getWizard(runtime);
  return ensureObject(wizard.fieldStateMap, "wizard.fieldStateMap");
}

export function getWizardPromptMap(runtime) {
  const wizard = getWizard(runtime);
  return ensureObject(wizard.promptByState, "wizard.promptByState");
}

export function getFlowText(runtime) {
  return {
    askCpfPortal: requireMessage(runtime, "askCpfPortal"),
    cpfInvalido: requireMessage(runtime, "cpfInvalido"),
    planDivergencia: requireMessage(runtime, "planDivergencia"),
    btnFalarAtendente: requireMessage(runtime, "btnFalarAtendente"),

    portalNeedData: requireMessage(runtime, "portalNeedData"),
    portalExistenteIncompletoBloqueio: requireMessage(
      runtime,
      "portalExistenteIncompletoBloqueio"
    ),

    askNome: requireMessage(runtime, "askNome"),
    askDtNasc: requireMessage(runtime, "askDtNasc"),
    askEmail: requireMessage(runtime, "askEmail"),
    askCep: requireMessage(runtime, "askCep"),
    askEndereco: requireMessage(runtime, "askEndereco"),
    askNumero: requireMessage(runtime, "askNumero"),
    askComplemento: requireMessage(runtime, "askComplemento"),
    askBairro: requireMessage(runtime, "askBairro"),
    askCidade: requireMessage(runtime, "askCidade"),
    askUf: requireMessage(runtime, "askUf"),

    menu: getMenu(runtime).text,
    lgpdConsent: requireMessage(runtime, "lgpdConsent"),
    lgpdRecusa: requireMessage(runtime, "lgpdRecusa"),

    buttonsOnlyWarning: requireMessage(runtime, "buttonsOnlyWarning"),
    pickPlanButtonsOnly: requireMessage(runtime, "pickPlanButtonsOnly"),

    bookingSessionInvalid: requireMessage(runtime, "bookingSessionInvalid"),
    bookingSlotConfirm: requireMessage(runtime, "bookingSlotConfirm"),
    bookingSlotInvalid: requireMessage(runtime, "bookingSlotInvalid"),
    bookingPatientNotIdentified: requireMessage(
      runtime,
      "bookingPatientNotIdentified"
    ),
    bookingAlreadyProcessing: requireMessage(
      runtime,
      "bookingAlreadyProcessing"
    ),
    bookingSlotNotFound: requireMessage(runtime, "bookingSlotNotFound"),
    bookingSlotTooSoon: requireMessage(runtime, "bookingSlotTooSoon"),
    bookingConfirmFailure: requireMessage(runtime, "bookingConfirmFailure"),
    bookingSuccessFallback: requireMessage(runtime, "bookingSuccessFallback"),
    bookingNoDates: requireMessage(runtime, "bookingNoDates"),
    bookingPickDate: requireMessage(runtime, "bookingPickDate"),
    bookingNoSlots: requireMessage(runtime, "bookingNoSlots"),
    bookingChangeDate: requireMessage(runtime, "bookingChangeDate"),
    bookingAvailableSlots: requireMessage(runtime, "bookingAvailableSlots"),
    bookingOptions: requireMessage(runtime, "bookingOptions"),
    bookingViewMore: requireMessage(runtime, "bookingViewMore"),

    wizardNewPatientName: requireMessage(runtime, "wizardNewPatientName"),
    profileLookupFailure: requireMessage(runtime, "profileLookupFailure"),
    planValidationFailure: requireMessage(runtime, "planValidationFailure"),
    nameInvalid: requireMessage(runtime, "nameInvalid"),
    dateInvalid: requireMessage(runtime, "dateInvalid"),
    emailInvalid: requireMessage(runtime, "emailInvalid"),
    cepInvalid: requireMessage(runtime, "cepInvalid"),
    addressInvalid: requireMessage(runtime, "addressInvalid"),
    addressNumberInvalid: requireMessage(runtime, "addressNumberInvalid"),
    districtInvalid: requireMessage(runtime, "districtInvalid"),
    cityInvalid: requireMessage(runtime, "cityInvalid"),
    ufInvalid: requireMessage(runtime, "ufInvalid"),
    registrationCreateFailure: requireMessage(
      runtime,
      "registrationCreateFailure"
    ),

    attendantDescribe: requireMessage(runtime, "attendantDescribe"),
    supportLinkMessage: requireMessage(runtime, "supportLinkMessage"),
    planNotEnabledMessage: requireMessage(runtime, "planNotEnabledMessage"),

    bookingSuccessMain: requireMessage(runtime, "bookingSuccessMain"),
    portalLinkPrefix: requireMessage(runtime, "portalLinkPrefix"),
    paymentInfoPrivateFirstVisit: requireMessage(
      runtime,
      "paymentInfoPrivateFirstVisit"
    ),

    sexPrompt: requireMessage(runtime, "sexPrompt"),
    sexMale: requireMessage(runtime, "sexMale"),
    sexFemale: requireMessage(runtime, "sexFemale"),
    sexNoInfo: requireMessage(runtime, "sexNoInfo"),

    planSelectionPrompt: requireMessage(runtime, "planSelectionPrompt"),

    actionConfirm: requireMessage(runtime, "actionConfirm"),
    actionPickOther: requireMessage(runtime, "actionPickOther"),

    redisUnavailable: getMessage(
      runtime,
      "redisUnavailable",
      "⚠️ Não foi possível continuar o atendimento agora. Por favor, tente novamente em instantes."
    ),
    providerUnavailable: getMessage(
      runtime,
      "providerUnavailable",
      "⚠️ Nosso sistema está temporariamente indisponível no momento. Por favor, tente novamente em instantes."
    ),
    inactivityClosedMessage: getMessage(
      runtime,
      "inactivityClosedMessage",
      "✅ Atendimento encerrado por inatividade."
    ),
  };
}
