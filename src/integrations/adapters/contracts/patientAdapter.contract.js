function assertPatientAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("Invalid patient adapter: adapter must be an object");
  }

  const requiredMethods = [
    "findPatientByDocument",
    "findPatientIdByDocument",
    "getPatientProfile",
    "validateRegistrationData",
    "listActivePlans",
    "hasPlan",
  ];

  for (const method of requiredMethods) {
    if (typeof adapter[method] !== "function") {
      throw new Error(
        `Invalid patient adapter: ${method} is required`
      );
    }
  }

  // 🔒 extensão futura segura (não obrigatório agora)
  // evita quebra quando adicionarmos novos métodos no futuro
  const optionalMethods = [
    "createPatient",
    "updatePatient", // hoje proibido por regra, mas pode existir no provider
    "getLastAppointment",
  ];

  for (const method of optionalMethods) {
    if (adapter[method] && typeof adapter[method] !== "function") {
      throw new Error(
        `Invalid patient adapter: ${method} must be a function if provided`
      );
    }
  }

  return adapter;
}

export { assertPatientAdapter };
