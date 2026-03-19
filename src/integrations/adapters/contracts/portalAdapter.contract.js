function assertPortalAdapter(adapter) {
  if (!adapter || typeof adapter.validateRegistrationData !== "function") {
    throw new Error(
      "Invalid portal adapter: validateRegistrationData is required"
    );
  }

  if (typeof adapter.createPatientRegistration !== "function") {
    throw new Error(
      "Invalid portal adapter: createPatientRegistration is required"
    );
  }

  return adapter;
}

export { assertPortalAdapter };
