import { assertSchedulingAdapter } from "../contracts/schedulingAdapter.contract.js";
import { createVersatilisSchedulingAdapter } from "../providers/versatilis/scheduling/versatilisSchedulingAdapter.js";
import { wrapAdapterWithResilience } from "../../resilience/wrapAdapterWithResilience.js";

function createSchedulingAdapter({ tenantId, runtime } = {}) {
  const providerKey = String(runtime?.providers?.booking || "").trim();

  if (!tenantId) {
    throw new Error("Missing tenantId for scheduling adapter");
  }

  if (!providerKey) {
    throw new Error("Missing provider: providers.booking");
  }

  if (providerKey === "versatilis") {
    const adapter = assertSchedulingAdapter(createVersatilisSchedulingAdapter());

    return wrapAdapterWithResilience({
      adapter,
      tenantId,
      runtime,
      capability: "booking",
    });
  }

  throw new Error(`Unsupported booking provider: ${providerKey}`);
}

export { createSchedulingAdapter };
