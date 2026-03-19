function assertSchedulingAdapter(adapter) {
  if (!adapter || typeof adapter.checkReturnEligibility !== "function") {
    throw new Error(
      "Invalid scheduling adapter: checkReturnEligibility is required"
    );
  }

  if (typeof adapter.findSlotsByDate !== "function") {
    throw new Error(
      "Invalid scheduling adapter: findSlotsByDate is required"
    );
  }

  if (typeof adapter.confirmBooking !== "function") {
    throw new Error(
      "Invalid scheduling adapter: confirmBooking is required"
    );
  }

  return adapter;
}

export { assertSchedulingAdapter };
