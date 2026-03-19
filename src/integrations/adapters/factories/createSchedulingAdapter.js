import { assertSchedulingAdapter } from "../contracts/schedulingAdapter.contract.js";
import { createVersatilisSchedulingAdapter as createDefaultBookingAdapter } from "../providers/versatilis/scheduling/versatilisSchedulingAdapter.js";

function createSchedulingAdapter(runtime = {}) {
  const providerKey = String(runtime?.providers?.bookingProvider || "").trim();

  if (providerKey === "provider_default") {
    return assertSchedulingAdapter(createDefaultBookingAdapter());
  }

  throw new Error(`Unsupported booking provider: ${providerKey}`);
}

export { createSchedulingAdapter };
