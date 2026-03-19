import { assertSchedulingAdapter } from "../contracts/schedulingAdapter.contract.js";
import { createVersatilisSchedulingAdapter } from "../providers/versatilis/scheduling/versatilisSchedulingAdapter.js";

function createSchedulingAdapter(runtime = {}) {
  const provider = String(runtime?.providers?.bookingProvider || "").trim();

  if (provider === "versatilis") {
    return assertSchedulingAdapter(createVersatilisSchedulingAdapter());
  }

  throw new Error(`Unsupported booking provider: ${provider}`);
}

export { createSchedulingAdapter };
