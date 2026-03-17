import { assertSchedulingAdapter } from "../contracts/schedulingAdapter.contract.js";
import { createVersatilisSchedulingAdapter } from "../providers/versatilis/scheduling/versatilisSchedulingAdapter.js";

function createSchedulingAdapter({ tenantConfig }) {
  const provider = String(
    tenantConfig?.integrations?.schedulingProvider || ""
  ).trim();

  if (provider === "versatilis") {
    return assertSchedulingAdapter(
      createVersatilisSchedulingAdapter({ tenantConfig })
    );
  }

  throw new Error(`Unsupported scheduling provider: ${provider}`);
}

export { createSchedulingAdapter };
