import { assertPortalAdapter } from "../contracts/portalAdapter.contract.js";
import { createVersatilisPortalAdapter } from "../providers/versatilis/portal/versatilisPortalAdapter.js";

function createPortalAdapter(runtime = {}) {
  const provider = String(runtime?.providers?.portalProvider || "").trim();

  if (provider === "versatilis") {
    return assertPortalAdapter(createVersatilisPortalAdapter(runtime));
  }

  throw new Error(`Unsupported portal provider: ${provider}`);
}

export { createPortalAdapter };
