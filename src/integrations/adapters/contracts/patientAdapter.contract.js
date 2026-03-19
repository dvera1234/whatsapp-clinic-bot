function assertPatientAdapter(adapter) {
  if (!adapter || typeof adapter.findPatientByDocument !== "function") {
    throw new Error("Invalid patient adapter: findPatientByDocument is required");
  }

  if (typeof adapter.findPatientIdByDocument !== "function") {
    throw new Error(
      "Invalid patient adapter: findPatientIdByDocument is required"
    );
  }

  if (typeof adapter.getPatientProfile !== "function") {
    throw new Error(
      "Invalid patient adapter: getPatientProfile is required"
    );
  }

  if (typeof adapter.validateRegistrationData !== "function") {
    throw new Error(
      "Invalid patient adapter: validateRegistrationData is required"
    );
  }

  if (typeof adapter.listActivePlans !== "function") {
    throw new Error(
      "Invalid patient adapter: listActivePlans is required"
    );
  }

  if (typeof adapter.hasPlan !== "function") {
    throw new Error("Invalid patient adapter: hasPlan is required");
  }

  return adapter;
}

export { assertPatientAdapter };
