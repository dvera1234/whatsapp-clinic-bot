import { assertPortalAdapter } from "../contracts/portalAdapter.contract.js";
import { createVersatilisPortalAdapter as createDefaultAccessAdapter } from "../providers/versatilis/portal/versatilisPortalAdapter.js";

function createPortalAdapter(runtime = {}) {
  const providerKey = String(runtime?.providers?.accessProvider || "").trim();

  if (providerKey === "provider_default") {
    return assertPortalAdapter(createDefaultAccessAdapter());
  }

  throw new Error(`Unsupported access provider: ${providerKey}`);
}

export { createPortalAdapter };
