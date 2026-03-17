function assertPortalAdapter(adapter) {
  if (!adapter || typeof adapter.validarCadastroCompleto !== "function") {
    throw new Error(
      "Invalid portal adapter: validarCadastroCompleto is required"
    );
  }

  if (typeof adapter.criarCadastroCompleto !== "function") {
    throw new Error(
      "Invalid portal adapter: criarCadastroCompleto is required"
    );
  }

  return adapter;
}

export { assertPortalAdapter };
