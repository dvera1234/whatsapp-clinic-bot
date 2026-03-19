import { tenantConfigs } from "../src/tenants/tenantConfig.js";
import { handleInbound } from "../src/flows/handleInbound.js";

const tenantId = process.argv[2] || "dr_davidvera_campinas";
const phone = String(process.argv[3] || "").replace(/\D+/g, "");
const text = process.argv[4] || "oi";

if (!phone) {
  console.error(
    "Uso: node scripts/test-handle-inbound-real.js <tenantId> <telefone> <texto>"
  );
  process.exit(1);
}

const tenantConfig = tenantConfigs[tenantId];

if (!tenantConfig) {
  console.error(`Tenant não encontrado em tenantConfigs: ${tenantId}`);
  process.exit(2);
}

try {
  await handleInbound({
    context: {
      tenantId,
      tenantConfig,
      phoneNumberId: tenantConfig?.channel?.phoneNumberId || null,
      traceId: "script-test-handle-inbound-real",
    },
    phone,
    text,
    phoneNumberIdFallback: tenantConfig?.channel?.phoneNumberId || null,
  });

  console.log("HANDLE_INBOUND_OK");
} catch (err) {
  console.error("HANDLE_INBOUND_FAIL");
  console.error(err?.stack || String(err));
  process.exit(3);
}
