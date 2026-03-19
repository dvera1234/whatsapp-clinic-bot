import { tenantConfigs } from "../src/tenants/tenantConfig.js";
import { buildTenantRuntime } from "../src/tenants/buildTenantRuntime.js";
import { createPatientAdapter } from "../src/integrations/adapters/factories/createPatientAdapter.js";

const tenantId = process.argv[2] || "dr_davidvera_campinas";
const document = String(process.argv[3] || "").replace(/\D+/g, "");

if (!document || document.length !== 11) {
  console.error("Uso: node scripts/test-patient-lookup.js <tenantId> <cpf>");
  process.exit(1);
}

const tenantConfig = tenantConfigs[tenantId];

if (!tenantConfig) {
  console.error(`Tenant não encontrado em tenantConfigs: ${tenantId}`);
  process.exit(2);
}

const runtimeResult = buildTenantRuntime(tenantConfig);

if (!runtimeResult?.ok) {
  console.error("Runtime inválido:");
  console.error(JSON.stringify(runtimeResult, null, 2));
  process.exit(3);
}

const runtime = runtimeResult.value;
const patientAdapter = createPatientAdapter(runtime);

try {
  const patientId = await patientAdapter.findPatientIdByDocument({
    document,
    runtimeCtx: {
      tenantId,
      tenantConfig,
      tenantRuntime: runtime,
      traceId: "script-test-patient-lookup",
      tracePhone: "***",
      privatePlanId: runtime?.plans?.privatePlanId ?? null,
      insuredPlanId: runtime?.plans?.insuredPlanId ?? null,
    },
  });

  console.log("PATIENT_LOOKUP_OK");
  console.log({ patientId: patientId || null });
} catch (err) {
  console.error("PATIENT_LOOKUP_FAIL");
  console.error(err?.stack || String(err));
  process.exit(4);
}
