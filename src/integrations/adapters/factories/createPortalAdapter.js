import { assertPortalAdapter } from "../contracts/portalAdapter.contract.js";
import { createVersatilisPortalAdapter } from "../providers/versatilis/portal/versatilisPortalAdapter.js";

function createPortalAdapter({ tenantConfig }) {
  const provider = String(
    tenantConfig?.integrations?.portalProvider || ""
  ).trim();

  if (provider === "versatilis") {
    return assertPortalAdapter(createVersatilisPortalAdapter({ tenantConfig }));
  }

  throw new Error(`Unsupported portal provider: ${provider}`);
}

export { createPortalAdapter };
