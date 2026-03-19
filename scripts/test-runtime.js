import { tenantConfigs } from "../src/tenants/tenantConfig.js";
import { buildTenantRuntime } from "../src/tenants/buildTenantRuntime.js";

const tenantId = process.argv[2] || "dr_davidvera_campinas";

const tenantConfig = tenantConfigs[tenantId];

if (!tenantConfig) {
  console.error(`Tenant não encontrado em tenantConfigs: ${tenantId}`);
  process.exit(1);
}

const runtime = buildTenantRuntime(tenantConfig);

console.log(JSON.stringify(runtime, null, 2));

if (!runtime?.ok) {
  process.exit(2);
}
