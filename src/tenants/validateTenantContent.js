function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function pushError(errors, condition, fieldName) {
  if (condition) errors.push(fieldName);
}

function buildPractitionerIdSet(practitioners = []) {
  const set = new Set();

  if (!Array.isArray(practitioners)) return set;

  for (const practitioner of practitioners) {
    const practitionerId = normalizeString(practitioner?.practitionerId);
    if (practitionerId) set.add(practitionerId);
  }

  return set;
}

function buildMessageKeySet(messages = {}) {
  const keys = new Set();

  if (!isObject(messages)) return keys;

  for (const key of Object.keys(messages)) {
    const normalizedKey = normalizeString(key);
    if (normalizedKey) keys.add(normalizedKey);
  }

  return keys;
}

function buildPlanIdSet(plans = []) {
  const set = new Set();

  if (!Array.isArray(plans)) return set;

  for (const plan of plans) {
    const planId = normalizeString(plan?.id);
    if (planId) set.add(planId);
  }

  return set;
}

function buildFlowKeySet(flows = {}) {
  const set = new Set();

  if (!isObject(flows)) return set;

  for (const key of Object.keys(flows)) {
    const normalizedKey = normalizeString(key);
    if (normalizedKey) set.add(normalizedKey);
  }

  return set;
}

function validateMenuOption(option, optionPath, errors, context) {
  pushError(errors, !isObject(option), optionPath);
  if (!isObject(option)) return;

  pushError(errors, !isNonEmptyString(option.id), `${optionPath}.id`);
  pushError(errors, !isNonEmptyString(option.label), `${optionPath}.label`);
  pushError(errors, !isNonEmptyString(option.action), `${optionPath}.action`);

  const action = normalizeString(option.action);
  const allowedActions = new Set([
    "OPEN_SUBMENU",
    "SHOW_MESSAGE",
    "SELECT_PLAN",
    "GO_STATE",
    "BACK_TO_MENU",
    "RESET_FLOW",
    "HANDOFF_HUMAN",
  ]);

  pushError(
    errors,
    !!action && !allowedActions.has(action),
    `${optionPath}.action_invalid`
  );

  if (action === "OPEN_SUBMENU") {
    const target = normalizeString(option.target);

    pushError(errors, !target, `${optionPath}.target`);
    if (target) {
      pushError(
        errors,
        !context.submenuKeys.has(target),
        `${optionPath}.target_missing`
      );
    }
  }

  if (action === "SHOW_MESSAGE") {
    const messageKey = normalizeString(option.messageKey);

    pushError(errors, !messageKey, `${optionPath}.messageKey`);
    if (messageKey) {
      pushError(
        errors,
        !context.messageKeys.has(messageKey),
        `${optionPath}.messageKey_missing`
      );
    }
  }

  if (action === "SELECT_PLAN") {
    const planId = normalizeString(option.planId);

    pushError(errors, !planId, `${optionPath}.planId`);
    if (planId) {
      pushError(
        errors,
        !context.planIdSet.has(planId),
        `${optionPath}.planId_missing`
      );
    }
  }

  if (action === "GO_STATE") {
    pushError(
      errors,
      !isNonEmptyString(option.targetState),
      `${optionPath}.targetState`
    );
  }
}

function validateMenuLike(menuLike, basePath, errors, context) {
  pushError(errors, !isObject(menuLike), basePath);
  if (!isObject(menuLike)) return;

  pushError(errors, !isNonEmptyString(menuLike.text), `${basePath}.text`);
  pushError(
    errors,
    !Array.isArray(menuLike.options) || menuLike.options.length === 0,
    `${basePath}.options`
  );

  if (!Array.isArray(menuLike.options)) return;

  menuLike.options.forEach((option, index) => {
    validateMenuOption(option, `${basePath}.options[${index}]`, errors, context);
  });
}

function validatePlanRules(plan, basePath, errors) {
  if (!("rules" in plan)) return;

  pushError(errors, !isObject(plan.rules), `${basePath}.rules`);
  if (!isObject(plan.rules)) return;

  if ("return" in plan.rules) {
    pushError(errors, !isObject(plan.rules.return), `${basePath}.rules.return`);

    if (isObject(plan.rules.return)) {
      if ("checkEligibility" in plan.rules.return) {
        pushError(
          errors,
          typeof plan.rules.return.checkEligibility !== "boolean",
          `${basePath}.rules.return.checkEligibility`
        );
      }

      if ("windowDays" in plan.rules.return) {
        pushError(
          errors,
          !Number.isInteger(plan.rules.return.windowDays) ||
            plan.rules.return.windowDays <= 0,
          `${basePath}.rules.return.windowDays`
        );
      }
    }
  }

  if ("billing" in plan.rules) {
    pushError(errors, !isObject(plan.rules.billing), `${basePath}.rules.billing`);

    if (isObject(plan.rules.billing)) {
      if ("enabled" in plan.rules.billing) {
        pushError(
          errors,
          typeof plan.rules.billing.enabled !== "boolean",
          `${basePath}.rules.billing.enabled`
        );
      }

      if ("mode" in plan.rules.billing) {
        pushError(
          errors,
          !isNonEmptyString(plan.rules.billing.mode),
          `${basePath}.rules.billing.mode`
        );
      }
    }
  }
}

function validatePlanBooking(plan, basePath, errors, practitionerIdSet) {
  if (!("booking" in plan)) return;

  pushError(errors, !isObject(plan.booking), `${basePath}.booking`);
  if (!isObject(plan.booking)) return;

  const practitionerMode = normalizeString(plan.booking.practitionerMode);
  const allowedModes = new Set(["FIXED", "USER_SELECT", "AUTO"]);

  pushError(
    errors,
    !practitionerMode,
    `${basePath}.booking.practitionerMode`
  );

  pushError(
    errors,
    !!practitionerMode && !allowedModes.has(practitionerMode),
    `${basePath}.booking.practitionerMode_invalid`
  );

  if ("practitionerIds" in plan.booking) {
    pushError(
      errors,
      !Array.isArray(plan.booking.practitionerIds) ||
        plan.booking.practitionerIds.length === 0,
      `${basePath}.booking.practitionerIds`
    );

    if (Array.isArray(plan.booking.practitionerIds)) {
      const localSet = new Set();

      plan.booking.practitionerIds.forEach((practitionerId, index) => {
        const entryPath = `${basePath}.booking.practitionerIds[${index}]`;
        const safePractitionerId = normalizeString(practitionerId);

        pushError(errors, !safePractitionerId, entryPath);

        if (safePractitionerId) {
          pushError(
            errors,
            localSet.has(safePractitionerId),
            `${entryPath}_duplicate`
          );

          pushError(
            errors,
            !practitionerIdSet.has(safePractitionerId),
            `${entryPath}_not_found`
          );

          localSet.add(safePractitionerId);
        }
      });
    }
  }

  if (practitionerMode === "FIXED") {
    pushError(
      errors,
      !Array.isArray(plan.booking.practitionerIds) ||
        plan.booking.practitionerIds.length !== 1,
      `${basePath}.booking.practitionerIds_fixed_invalid`
    );
  }

  if (practitionerMode === "USER_SELECT") {
    pushError(
      errors,
      !Array.isArray(plan.booking.practitionerIds) ||
        plan.booking.practitionerIds.length === 0,
      `${basePath}.booking.practitionerIds_user_select_required`
    );
  }
}

function validatePlanMappings(plan, basePath, errors) {
  if (!("mappings" in plan)) return;

  pushError(errors, !isObject(plan.mappings), `${basePath}.mappings`);
  if (!isObject(plan.mappings)) return;

  if ("externalId" in plan.mappings) {
    const externalId = plan.mappings.externalId;

    pushError(
      errors,
      !(
        (typeof externalId === "number" && Number.isFinite(externalId)) ||
        (typeof externalId === "string" && normalizeString(externalId) !== "")
      ),
      `${basePath}.mappings.externalId`
    );
  }
}

function validateFlow(flowPath, flowValue, errors, context) {
  pushError(errors, !isObject(flowValue), flowPath);
  if (!isObject(flowValue)) return;

  pushError(errors, !isNonEmptyString(flowValue.type), `${flowPath}.type`);

  const normalizedType = normalizeString(flowValue.type).toUpperCase();
  const allowedFlowTypes = new Set([
    "CONTINUE",
    "END",
    "INFO_ONLY",
    "BOOKING",
    "OPEN_SUBMENU",
    "DIRECT_BOOKING",
  ]);

  pushError(
    errors,
    !!normalizedType && !allowedFlowTypes.has(normalizedType),
    `${flowPath}.type_invalid`
  );

  if ("handler" in flowValue) {
    const handler = normalizeString(flowValue.handler);

    pushError(errors, !handler, `${flowPath}.handler`);
    if (handler) {
      pushError(
        errors,
        !context.allowedHandlerNames.has(handler),
        `${flowPath}.handler_invalid`
      );
    }
  }

  if ("messageKey" in flowValue) {
    const messageKey = normalizeString(flowValue.messageKey);

    pushError(errors, !messageKey, `${flowPath}.messageKey`);
    if (messageKey) {
      pushError(
        errors,
        !context.messageKeys.has(messageKey),
        `${flowPath}.messageKey_missing`
      );
    }
  }

  if (normalizedType === "OPEN_SUBMENU") {
    const target = normalizeString(flowValue.target);

    pushError(errors, !target, `${flowPath}.target`);
    if (target) {
      pushError(
        errors,
        !context.submenuKeys.has(target),
        `${flowPath}.target_missing`
      );
    }
  }

  if ("nextState" in flowValue) {
    pushError(
      errors,
      !isNonEmptyString(flowValue.nextState),
      `${flowPath}.nextState`
    );
  }
}

function validatePlan(plan, index, flowMap, errors, context) {
  const basePath = `plans[${index}]`;

  pushError(errors, !isObject(plan), basePath);
  if (!isObject(plan)) return;

  const planId = normalizeString(plan.id);
  const planKey = normalizeString(plan.key);
  const planFlow = normalizeString(plan.flow);

  pushError(errors, !planId, `${basePath}.id`);
  pushError(errors, !planKey, `${basePath}.key`);
  pushError(errors, !planFlow, `${basePath}.flow`);
  pushError(errors, !isNonEmptyString(plan.label), `${basePath}.label`);

  if (planId) {
    pushError(errors, context.planIds.has(planId), `${basePath}.id_duplicate`);
    context.planIds.add(planId);
  }

  if (planKey) {
    pushError(errors, context.planKeys.has(planKey), `${basePath}.key_duplicate`);
    context.planKeys.add(planKey);
  }

  if (planFlow) {
    pushError(errors, !flowMap[planFlow], `${basePath}.flow_missing`);
  }

  if ("nextState" in plan) {
    pushError(
      errors,
      !isNonEmptyString(plan.nextState),
      `${basePath}.nextState`
    );
  }

  if ("messageKey" in plan) {
    const messageKey = normalizeString(plan.messageKey);

    pushError(errors, !messageKey, `${basePath}.messageKey`);
    if (messageKey) {
      pushError(
        errors,
        !context.messageKeys.has(messageKey),
        `${basePath}.messageKey_missing`
      );
    }
  }

  validatePlanRules(plan, basePath, errors);
  validatePlanBooking(plan, basePath, errors, context.practitionerIdSet);
  validatePlanMappings(plan, basePath, errors);
}

function validateDispatchHandlerName(handlerName, path, errors, context) {
  const safeHandlerName = normalizeString(handlerName);

  pushError(errors, !safeHandlerName, path);
  if (!safeHandlerName) return;

  pushError(
    errors,
    !context.allowedHandlerNames.has(safeHandlerName),
    `${path}_invalid`
  );
}

function validateDispatchMap(mapValue, path, errors, context) {
  pushError(errors, !isObject(mapValue), path);
  if (!isObject(mapValue)) return;

  for (const [rawKey, rawHandlerName] of Object.entries(mapValue)) {
    const safeKey = normalizeString(rawKey);
    const entryPath = `${path}.${rawKey}`;

    pushError(errors, !safeKey, `${entryPath}_key`);
    validateDispatchHandlerName(rawHandlerName, entryPath, errors, context);
  }
}

function validateDispatch(dispatch, errors, context) {
  pushError(errors, !isObject(dispatch), "dispatch");
  if (!isObject(dispatch)) return;

  validateDispatchMap(
    dispatch.stateHandlers,
    "dispatch.stateHandlers",
    errors,
    context
  );

  validateDispatchMap(
    dispatch.statePrefixes,
    "dispatch.statePrefixes",
    errors,
    context
  );

  pushError(
    errors,
    !isObject(dispatch.flowTypeHandlers),
    "dispatch.flowTypeHandlers"
  );

  if (isObject(dispatch.flowTypeHandlers)) {
    const allowedFlowTypes = new Set([
      "CONTINUE",
      "END",
      "INFO_ONLY",
      "BOOKING",
      "OPEN_SUBMENU",
      "DIRECT_BOOKING",
    ]);

    for (const [rawFlowType, rawHandlerName] of Object.entries(
      dispatch.flowTypeHandlers
    )) {
      const safeFlowType = normalizeString(rawFlowType).toUpperCase();
      const entryPath = `dispatch.flowTypeHandlers.${rawFlowType}`;

      pushError(errors, !safeFlowType, `${entryPath}_key`);
      pushError(
        errors,
        !!safeFlowType && !allowedFlowTypes.has(safeFlowType),
        `${entryPath}_key_invalid`
      );

      validateDispatchHandlerName(rawHandlerName, entryPath, errors, context);
    }
  }

  validateDispatchHandlerName(
    dispatch.defaultHandler,
    "dispatch.defaultHandler",
    errors,
    context
  );
}

export function validateTenantContent(content = {}, context = {}) {
  const errors = [];

  if (!isObject(content)) {
    return {
      ok: false,
      errors: ["content"],
    };
  }

  const practitionerIdSet = buildPractitionerIdSet(context?.practitioners);
  const messageKeys = buildMessageKeySet(content.messages);
  const submenuKeys = new Set(
    isObject(content.submenus) ? Object.keys(content.submenus) : []
  );
  const planIdSet = buildPlanIdSet(content.plans);
  const flowKeySet = buildFlowKeySet(content.flows);

  const allowedHandlerNames = new Set([
    "mainMenu",
    "planSelection",
    "portalFlow",
    "patientIdentification",
    "patientRegistration",
    "slotSelection",
    "bookingConfirmation",
    "support",
  ]);

  const validationContext = {
    practitionerIdSet,
    messageKeys,
    submenuKeys,
    planIdSet,
    flowKeySet,
    allowedHandlerNames,
    planIds: new Set(),
    planKeys: new Set(),
  };

  pushError(
    errors,
    !Array.isArray(content.plans) || content.plans.length === 0,
    "plans"
  );

  pushError(errors, !isObject(content.flows), "flows");
  const flowMap = isObject(content.flows) ? content.flows : {};

  if (isObject(content.flows)) {
    for (const [flowKey, flowValue] of Object.entries(flowMap)) {
      validateFlow(`flows.${flowKey}`, flowValue, errors, validationContext);
    }
  }

  validateDispatch(content.dispatch, errors, validationContext);

  pushError(errors, !isObject(content.messages), "messages");

  if (isObject(content.messages)) {
    const messages = content.messages;

    pushError(
      errors,
      !isNonEmptyString(messages.lgpdConsent),
      "messages.lgpdConsent"
    );
    pushError(
      errors,
      !isNonEmptyString(messages.lgpdButtonText),
      "messages.lgpdButtonText"
    );
    pushError(
      errors,
      !isNonEmptyString(messages.lgpdSectionTitle),
      "messages.lgpdSectionTitle"
    );
    pushError(
      errors,
      !isNonEmptyString(messages.lgpdAcceptLabel),
      "messages.lgpdAcceptLabel"
    );
    pushError(
      errors,
      !isNonEmptyString(messages.lgpdRejectLabel),
      "messages.lgpdRejectLabel"
    );
    pushError(
      errors,
      !isNonEmptyString(messages.askCpfPortal),
      "messages.askCpfPortal"
    );
  }

  validateMenuLike(content.menu, "menu", errors, validationContext);

  if ("submenus" in content) {
    pushError(errors, !isObject(content.submenus), "submenus");

    if (isObject(content.submenus)) {
      for (const [submenuKey, submenuValue] of Object.entries(content.submenus)) {
        validateMenuLike(
          submenuValue,
          `submenus.${submenuKey}`,
          errors,
          validationContext
        );
      }
    }
  }

  if (Array.isArray(content.plans)) {
    content.plans.forEach((plan, index) => {
      validatePlan(plan, index, flowMap, errors, validationContext);
    });
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
