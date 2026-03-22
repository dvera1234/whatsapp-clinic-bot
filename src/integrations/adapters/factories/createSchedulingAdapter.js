import { assertSchedulingAdapter } from "../contracts/schedulingAdapter.contract.js";
import { createVersatilisSchedulingAdapter } from "../providers/versatilis/scheduling/versatilisSchedulingAdapter.js";
import { wrapAdapterWithResilience } from "../../resilience/wrapAdapterWithResilience.js";

function createSchedulingAdapter({ tenantId, runtime } = {}) {
  if (!tenantId) {
    throw new Error("Missing tenantId for scheduling adapter");
  }

  if (!runtime || typeof runtime !== "object") {
    throw new Error("Missing runtime for scheduling adapter");
  }

  const providerKey = String(runtime?.providers?.booking || "").trim();

  if (!providerKey) {
    throw new Error("Missing provider: providers.booking");
  }

  let adapter;

  switch (providerKey) {
    case "versatilis":
      adapter = createVersatilisSchedulingAdapter({ tenantId, runtime });
      break;

    default:
      throw new Error(`Unsupported booking provider: ${providerKey}`);
  }

  assertSchedulingAdapter(adapter);

  return wrapAdapterWithResilience({
    adapter,
    tenantId,
    runtime,
    capability: "booking",
  });
}

export { createSchedulingAdapter };
