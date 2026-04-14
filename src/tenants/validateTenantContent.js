function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function pushError(errors, condition, fieldName) {
  if (condition) errors.push(fieldName);
}

function buildPractitionerIdSet(practitioners = []) {
  const set = new Set();

  if (!Array.isArray(practitioners)) return set;

  for (const practitioner of practitioners) {
    const practitionerId = String(practitioner?.practitionerId || "").trim();
    if (practitionerId) set.add(practitionerId);
  }

  return set;
}

function validateMenuLike(menuLike, basePath, errors) {
  pushError(errors, !isObject(menuLike), basePath);
  if (!isObject(menuLike)) return;

  pushError(errors, !isNonEmptyString(menuLike.text), `${basePath}.text`);
  pushError(
    errors,
    !Array.isArray(menuLike.options) || menuLike.options.length === 0,
    `${basePath}.options`
  );

  if (!Array.isArray(menuLike.options)) return;

  menuLike.options.forEach((opt, i) => {
    const optionPath = `${basePath}.options[${i}]`;

    pushError(errors, !isObject(opt), optionPath);
    if (!isObject(opt)) return;

    pushError(errors, !isNonEmptyString(opt.id), `${optionPath}.id`);
    pushError(errors, !isNonEmptyString(opt.label), `${optionPath}.label`);
    pushError(errors, !isNonEmptyString(opt.action), `${optionPath}.action`);

    const action = String(opt.action || "").trim();

    if (action === "OPEN_SUBMENU") {
      pushError(errors, !isNonEmptyString(opt.target), `${optionPath}.target`);
    }

    if (action === "SHOW_MESSAGE") {
      pushError(
        errors,
        !isNonEmptyString(opt.messageKey),
        `${optionPath}.messageKey`
      );
    }

    if (action === "SELECT_PLAN") {
      pushError(errors, !isNonEmptyString(opt.planId), `${optionPath}.planId`);
    }

    if (action === "GO_STATE") {
      pushError(
        errors,
        !isNonEmptyString(opt.targetState),
        `${optionPath}.targetState`
      );
    }
  });
}

function validatePlanRules(plan, basePath, errors) {
  if (!("rules" in plan)) return;

  pushError(errors, !isObject(plan.rules), `${basePath}.rules`);
  if (!isObject(plan.rules)) return;

  if ("return" in plan.rules) {
    pushError(
      errors,
      !isObject(plan.rules.return),
      `${basePath}.rules.return`
    );

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
    pushError(
      errors,
      !isObject(plan.rules.billing),
      `${basePath}.rules.billing`
    );

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

  if ("practitionerIds" in plan.booking) {
    pushError(
      errors,
      !Array.isArray(plan.booking.practitionerIds) ||
        plan.booking.practitionerIds.length === 0,
      `${basePath}.booking.practitionerIds`
    );

    if (Array.isArray(plan.booking.practitionerIds)) {
      plan.booking.practitionerIds.forEach((practitionerId, index) => {
        const entryPath = `${basePath}.booking.practitionerIds[${index}]`;

        pushError(errors, !isNonEmptyString(practitionerId), entryPath);

        if (isNonEmptyString(practitionerId)) {
          pushError(
            errors,
            !practitionerIdSet.has(String(practitionerId).trim()),
            `${entryPath}_not_found`
          );
        }
      });
    }
  }

  if ("practitionerMode" in plan.booking) {
    pushError(
      errors,
      !isNonEmptyString(plan.booking.practitionerMode),
      `${basePath}.booking.practitionerMode`
    );
  }
}

function validatePlanMappings(plan, basePath, errors) {
  if (!("mappings" in plan)) return;

  pushError(errors, !isObject(plan.mappings), `${basePath}.mappings`);
  if (!isObject(plan.mappings)) return;

  if ("externalId" in plan.mappings) {
    const ext = plan.mappings.externalId;

    pushError(
      errors,
      !(
        (typeof ext === "number" && Number.isFinite(ext)) ||
        (typeof ext === "string" && ext.trim() !== "")
      ),
      `${basePath}.mappings.externalId`
    );
  }
}

function validatePlan(plan, index, flowMap, errors, seenPlanIds, seenPlanKeys, practitionerIdSet) {
  const basePath = `plans[${index}]`;

  pushError(errors, !isObject(plan), basePath);
  if (!isObject(plan)) return;

  const planId = String(plan.id || "").trim();
  const planKey = String(plan.key || "").trim();
  const planFlow = String(plan.flow || "").trim();

  pushError(errors, !planId, `${basePath}.id`);
  pushError(errors, !planKey, `${basePath}.key`);
  pushError(errors, !planFlow, `${basePath}.flow`);
  pushError(errors, !isNonEmptyString(plan.label), `${basePath}.label`);

  if (planId) {
    pushError(errors, seenPlanIds.has(planId), `${basePath}.id_duplicate`);
    seenPlanIds.add(planId);
  }

  if (planKey) {
    pushError(errors, seenPlanKeys.has(planKey), `${basePath}.key_duplicate`);
    seenPlanKeys.add(planKey);
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
    pushError(
      errors,
      !isNonEmptyString(plan.messageKey),
      `${basePath}.messageKey`
    );
  }

  validatePlanRules(plan, basePath, errors);
  validatePlanBooking(plan, basePath, errors, practitionerIdSet);
  validatePlanMappings(plan, basePath, errors);
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

  validateMenuLike(content.menu, "menu", errors);

  if ("submenus" in content) {
    pushError(errors, !isObject(content.submenus), "submenus");

    if (isObject(content.submenus)) {
      for (const [submenuKey, submenuValue] of Object.entries(content.submenus)) {
        validateMenuLike(submenuValue, `submenus.${submenuKey}`, errors);
      }
    }
  }

  pushError(errors, !isObject(content.flows), "flows");

  const flowMap = isObject(content.flows) ? content.flows : {};
  const allowedFlowTypes = new Set([
    "CONTINUE",
    "END",
    "INFO_ONLY",
    "BOOKING",
    "OPEN_SUBMENU",
    "DIRECT_BOOKING",
  ]);

  for (const [flowKey, flowValue] of Object.entries(flowMap)) {
    const flowPath = `flows.${flowKey}`;

    pushError(errors, !isObject(flowValue), flowPath);
    if (!isObject(flowValue)) continue;

    pushError(errors, !isNonEmptyString(flowValue.type), `${flowPath}.type`);

    const normalizedType = String(flowValue.type || "").trim().toUpperCase();
    pushError(
      errors,
      !!normalizedType && !allowedFlowTypes.has(normalizedType),
      `${flowPath}.type_invalid`
    );
  }

  pushError(errors, !Array.isArray(content.plans), "plans");

  const seenPlanIds = new Set();
  const seenPlanKeys = new Set();

  if (Array.isArray(content.plans)) {
    content.plans.forEach((plan, index) => {
      validatePlan(
        plan,
        index,
        flowMap,
        errors,
        seenPlanIds,
        seenPlanKeys,
        practitionerIdSet
      );
    });
  }

  pushError(errors, !isObject(content.messages), "messages");

  if (isObject(content.messages)) {
    const m = content.messages;

    pushError(errors, !isNonEmptyString(m.lgpdConsent), "messages.lgpdConsent");
    pushError(
      errors,
      !isNonEmptyString(m.lgpdButtonText),
      "messages.lgpdButtonText"
    );
    pushError(
      errors,
      !isNonEmptyString(m.lgpdSectionTitle),
      "messages.lgpdSectionTitle"
    );
    pushError(
      errors,
      !isNonEmptyString(m.lgpdAcceptLabel),
      "messages.lgpdAcceptLabel"
    );
    pushError(
      errors,
      !isNonEmptyString(m.lgpdRejectLabel),
      "messages.lgpdRejectLabel"
    );
    pushError(
      errors,
      !isNonEmptyString(m.askCpfPortal),
      "messages.askCpfPortal"
    );
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
