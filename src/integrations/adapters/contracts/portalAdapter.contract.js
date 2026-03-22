function assertPortalAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("Invalid portal adapter: adapter must be an object");
  }

  const requiredMethods = [
    "validateRegistrationData",
    "createPatientRegistration",
  ];

  for (const method of requiredMethods) {
    if (typeof adapter[method] !== "function") {
      throw new Error(
        `Invalid portal adapter: ${method} is required`
      );
    }
  }

  // 🔒 extensões futuras seguras
  const optionalMethods = [
    "resetPassword",
    "sendAccessLink",
    "checkPortalAccess",
  ];

  for (const method of optionalMethods) {
    if (adapter[method] && typeof adapter[method] !== "function") {
      throw new Error(
        `Invalid portal adapter: ${method} must be a function if provided`
      );
    }
  }

  return adapter;
}

export { assertPortalAdapter };
