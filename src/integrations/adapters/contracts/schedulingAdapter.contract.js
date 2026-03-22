function assertSchedulingAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("Invalid scheduling adapter: adapter must be an object");
  }

  const requiredMethods = [
    "checkReturnEligibility",
    "findSlotsByDate",
    "confirmBooking",
  ];

  for (const method of requiredMethods) {
    if (typeof adapter[method] !== "function") {
      throw new Error(
        `Invalid scheduling adapter: ${method} is required`
      );
    }
  }

  // 🔒 extensões futuras seguras
  const optionalMethods = [
    "findNextAvailableDates",
    "cancelBooking",
    "rescheduleBooking",
  ];

  for (const method of optionalMethods) {
    if (adapter[method] && typeof adapter[method] !== "function") {
      throw new Error(
        `Invalid scheduling adapter: ${method} must be a function if provided`
      );
    }
  }

  return adapter;
}

export { assertSchedulingAdapter };
