import { assertPortalAdapter } from "../contracts/portalAdapter.contract.js";
import { createVersatilisPortalAdapter } from "../providers/versatilis/portal/versatilisPortalAdapter.js";
import { wrapAdapterWithResilience } from "../../resilience/wrapAdapterWithResilience.js";

function createPortalAdapter({ tenantId, runtime } = {}) {
  const providerKey = String(runtime?.providers?.access || "").trim();

  if (!tenantId) {
    throw new Error("Missing tenantId for portal adapter");
  }

  if (!providerKey) {
    throw new Error("Missing provider: providers.access");
  }

  if (providerKey === "versatilis") {
    const adapter = assertPortalAdapter(createVersatilisPortalAdapter());

    return wrapAdapterWithResilience({
      adapter,
      tenantId,
      runtime,
      capability: "access",
    });
  }

  throw new Error(`Unsupported access provider: ${providerKey}`);
}

export { createPortalAdapter };
