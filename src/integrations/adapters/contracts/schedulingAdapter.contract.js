function assertSchedulingAdapter(adapter) {
  if (!adapter || typeof adapter.verificarRetorno30Dias !== "function") {
    throw new Error(
      "Invalid scheduling adapter: verificarRetorno30Dias is required"
    );
  }

  if (typeof adapter.buscarSlotsDoDia !== "function") {
    throw new Error(
      "Invalid scheduling adapter: buscarSlotsDoDia is required"
    );
  }

  if (typeof adapter.confirmarAgendamento !== "function") {
    throw new Error(
      "Invalid scheduling adapter: confirmarAgendamento is required"
    );
  }

  return adapter;
}

export { assertSchedulingAdapter };
