import { resolveTenant } from "../src/tenants/resolveTenant.js";
import { tenantConfigs } from "../src/tenants/tenantConfig.js";

const tenantId = process.argv[2] || "dr_davidvera_campinas";
const tenantConfig = tenantConfigs[tenantId];

if (!tenantConfig) {
  console.error(`Tenant não encontrado em tenantConfigs: ${tenantId}`);
  process.exit(1);
}

const channelId = tenantConfig?.channel?.phoneNumberId;

if (!channelId) {
  console.error(`channel.phoneNumberId ausente para o tenant: ${tenantId}`);
  process.exit(2);
}

const result = resolveTenant(channelId);

console.log(JSON.stringify(result, null, 2));

if (!result?.ok) {
  process.exit(3);
}
