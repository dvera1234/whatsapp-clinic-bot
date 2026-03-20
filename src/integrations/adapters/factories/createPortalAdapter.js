import { assertPortalAdapter } from "../contracts/portalAdapter.contract.js";
import { createVersatilisPortalAdapter } from "../providers/versatilis/portal/versatilisPortalAdapter.js";

function createPortalAdapter(runtime = {}) {
  const providerKey = String(runtime?.providers?.access || "").trim();

  if (!providerKey) {
    throw new Error("Missing provider: providers.access");
  }

  if (providerKey === "versatilis") {
    return assertPortalAdapter(createVersatilisPortalAdapter());
  }

  throw new Error(`Unsupported access provider: ${providerKey}`);
}

export { createPortalAdapter };
