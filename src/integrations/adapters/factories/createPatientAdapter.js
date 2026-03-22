import { assertPatientAdapter } from "../contracts/patientAdapter.contract.js";
import { createVersatilisPatientAdapter } from "../providers/versatilis/patient/versatilisPatientAdapter.js";
import { wrapAdapterWithResilience } from "../../resilience/wrapAdapterWithResilience.js";

function createPatientAdapter({ tenantId, runtime } = {}) {
  if (!tenantId) {
    throw new Error("Missing tenantId for patient adapter");
  }

  if (!runtime || typeof runtime !== "object") {
    throw new Error("Missing runtime for patient adapter");
  }

  const providerKey = String(runtime?.providers?.identity || "").trim();

  if (!providerKey) {
    throw new Error("Missing provider: providers.identity");
  }

  let adapter;

  switch (providerKey) {
    case "versatilis":
      adapter = createVersatilisPatientAdapter({ tenantId, runtime });
      break;

    default:
      throw new Error(`Unsupported identity provider: ${providerKey}`);
  }

  assertPatientAdapter(adapter);

  return wrapAdapterWithResilience({
    adapter,
    tenantId,
    runtime,
    capability: "identity",
  });
}

export { createPatientAdapter };
