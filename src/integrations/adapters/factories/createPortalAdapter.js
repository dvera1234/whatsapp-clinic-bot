import { assertPortalAdapter } from "../contracts/portalAdapter.contract.js";
import { createVersatilisPortalAdapter } from "../providers/versatilis/portal/versatilisPortalAdapter.js";

function createPortalAdapter(runtime = {}) {
  const provider = String(runtime?.providers?.accessProvider || "").trim();

  if (provider === "versatilis") {
    return assertPortalAdapter(createVersatilisPortalAdapter());
  }

  throw new Error(`Unsupported access provider: ${provider}`);
}

export { createPortalAdapter };
