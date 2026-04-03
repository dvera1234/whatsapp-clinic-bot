export function validateTenantContent(content = {}) {
  const errors = [];

  // MENU
  if (!content.menu?.text) {
    errors.push("menu.text");
  }

  if (!Array.isArray(content.menu?.options)) {
    errors.push("menu.options");
  } else {
    content.menu.options.forEach((opt, i) => {
      if (!opt.id) errors.push(`menu.options[${i}].id`);
      if (!opt.action) errors.push(`menu.options[${i}].action`);
    });
  }

  // PLANS
  if (!Array.isArray(content.plans)) {
    errors.push("plans");
  } else {
    content.plans.forEach((p, i) => {
      if (!p.id) errors.push(`plans[${i}].id`);
      if (!p.key) errors.push(`plans[${i}].key`);
      if (!p.flow) errors.push(`plans[${i}].flow`);
      if (!p.label) errors.push(`plans[${i}].label`);
    });
  }

  // FLOWS
  if (!content.flows) {
    errors.push("flows");
  }

  // MESSAGES
  if (!content.messages) {
    errors.push("messages");
  }

  return {
    ok: errors.length === 0,
    errors
  };
}
