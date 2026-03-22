import { assertPortalAdapter } from "../contracts/portalAdapter.contract.js";
import { createVersatilisPortalAdapter } from "../providers/versatilis/portal/versatilisPortalAdapter.js";
import { wrapAdapterWithResilience } from "../../resilience/wrapAdapterWithResilience.js";

function createPortalAdapter({ tenantId, runtime } = {}) {
  if (!tenantId) {
    throw new Error("Missing tenantId for portal adapter");
  }

  if (!runtime || typeof runtime !== "object") {
    throw new Error("Missing runtime for portal adapter");
  }

  const providerKey = String(runtime?.providers?.access || "").trim();

  if (!providerKey) {
    throw new Error("Missing provider: providers.access");
  }

  let adapter;

  switch (providerKey) {
    case "versatilis":
      adapter = createVersatilisPortalAdapter({ tenantId, runtime });
      break;

    default:
      throw new Error(`Unsupported access provider: ${providerKey}`);
  }

  assertPortalAdapter(adapter);

  return wrapAdapterWithResilience({
    adapter,
    tenantId,
    runtime,
    capability: "access",
  });
}

export { createPortalAdapter };
