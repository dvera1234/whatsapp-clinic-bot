import { assertSchedulingAdapter } from "../contracts/schedulingAdapter.contract.js";
import { createVersatilisSchedulingAdapter } from "../providers/versatilis/scheduling/versatilisSchedulingAdapter.js";

function createSchedulingAdapter(runtime = {}) {
  const providerKey = String(
    runtime?.providers?.booking ||
      runtime?.providers?.scheduling ||
      runtime?.providers?.schedulingProvider ||
      ""
  ).trim();

  if (providerKey === "versatilis") {
    return assertSchedulingAdapter(createVersatilisSchedulingAdapter());
  }

  throw new Error(`Unsupported booking provider: ${providerKey}`);
}

export { createSchedulingAdapter };
