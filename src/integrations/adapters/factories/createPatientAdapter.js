import { assertPatientAdapter } from "../contracts/patientAdapter.contract.js";
import { createVersatilisPatientAdapter } from "../providers/versatilis/patient/versatilisPatientAdapter.js";
import { wrapAdapterWithResilience } from "../../resilience/wrapAdapterWithResilience.js";

function createPatientAdapter({ tenantId, runtime } = {}) {
  const providerKey = String(runtime?.providers?.identity || "").trim();

  if (!tenantId) {
    throw new Error("Missing tenantId for patient adapter");
  }

  if (!providerKey) {
    throw new Error("Missing provider: providers.identity");
  }

  if (providerKey === "versatilis") {
    const adapter = assertPatientAdapter(createVersatilisPatientAdapter());

    return wrapAdapterWithResilience({
      adapter,
      tenantId,
      runtime,
      capability: "identity",
    });
  }

  throw new Error(`Unsupported identity provider: ${providerKey}`);
}

export { createPatientAdapter };
