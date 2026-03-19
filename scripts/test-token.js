import { tenantConfigs } from "../src/tenants/tenantConfig.js";
import { getProviderAccessToken } from "../src/integrations/transport/versatilis/auth.js";

const tenantId = process.argv[2] || "dr_davidvera_campinas";
const tenantConfig = tenantConfigs[tenantId];

if (!tenantConfig) {
  console.error(`Tenant não encontrado em tenantConfigs: ${tenantId}`);
  process.exit(1);
}

try {
  const token = await getProviderAccessToken({
    tenantId,
    tenantConfig,
  });

  console.log("TOKEN_OK");
  console.log(`len=${String(token || "").length}`);
  console.log(`preview=${String(token || "").slice(0, 12)}...`);
} catch (err) {
  console.error("TOKEN_FAIL");
  console.error(err?.stack || String(err));
  process.exit(2);
}
