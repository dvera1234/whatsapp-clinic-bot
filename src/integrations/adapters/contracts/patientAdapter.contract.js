function assertPatientAdapter(adapter) {
  if (!adapter || typeof adapter.buscarPacientePorCpf !== "function") {
    throw new Error("Invalid patient adapter: buscarPacientePorCpf is required");
  }

  if (typeof adapter.buscarPacientePorCpfComFallback !== "function") {
    throw new Error(
      "Invalid patient adapter: buscarPacientePorCpfComFallback is required"
    );
  }

  if (typeof adapter.buscarPerfilPaciente !== "function") {
    throw new Error(
      "Invalid patient adapter: buscarPerfilPaciente is required"
    );
  }

  if (typeof adapter.normalizarPlanosAtivos !== "function") {
    throw new Error(
      "Invalid patient adapter: normalizarPlanosAtivos is required"
    );
  }

  if (typeof adapter.temPlano !== "function") {
    throw new Error("Invalid patient adapter: temPlano is required");
  }

  return adapter;
}

export { assertPatientAdapter };
