import { assertSchedulingAdapter } from "../contracts/schedulingAdapter.contract.js";
import { createVersatilisSchedulingAdapter } from "../providers/versatilis/scheduling/versatilisSchedulingAdapter.js";

function createSchedulingAdapter(runtime = {}) {
  const provider = String(runtime?.providers?.schedulingProvider || "").trim();

  if (provider === "versatilis") {
    return assertSchedulingAdapter(createVersatilisSchedulingAdapter());
  }

  throw new Error(`Unsupported scheduling provider: ${provider}`);
}

export { createSchedulingAdapter };
