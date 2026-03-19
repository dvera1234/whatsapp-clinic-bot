import { tenantConfigs } from "../src/tenants/tenantConfig.js";
import { buildTenantRuntime } from "../src/tenants/buildTenantRuntime.js";
import { createPatientAdapter } from "../src/integrations/adapters/factories/createPatientAdapter.js";
import { createPortalAdapter } from "../src/integrations/adapters/factories/createPortalAdapter.js";
import { createSchedulingAdapter } from "../src/integrations/adapters/factories/createSchedulingAdapter.js";

const tenantId = process.argv[2] || "dr_davidvera_campinas";
const tenantConfig = tenantConfigs[tenantId];

if (!tenantConfig) {
  console.error(`Tenant não encontrado em tenantConfigs: ${tenantId}`);
  process.exit(1);
}

const runtimeResult = buildTenantRuntime(tenantConfig);

if (!runtimeResult?.ok) {
  console.error("Runtime inválido:");
  console.error(JSON.stringify(runtimeResult, null, 2));
  process.exit(2);
}

const runtime = runtimeResult.value;

try {
  const patientAdapter = createPatientAdapter(runtime);
  const portalAdapter = createPortalAdapter(runtime);
  const schedulingAdapter = createSchedulingAdapter(runtime);

  console.log("ADAPTERS_OK");
  console.log({
    patientAdapterMethods: Object.keys(patientAdapter).sort(),
    portalAdapterMethods: Object.keys(portalAdapter).sort(),
    schedulingAdapterMethods: Object.keys(schedulingAdapter).sort(),
  });
} catch (err) {
  console.error("ADAPTERS_FAIL");
  console.error(err?.stack || String(err));
  process.exit(3);
}
