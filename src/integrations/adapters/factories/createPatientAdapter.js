import { assertPatientAdapter } from "../contracts/patientAdapter.contract.js";
import { createVersatilisPatientAdapter as createDefaultIdentityAdapter } from "../providers/versatilis/patient/versatilisPatientAdapter.js";

function createPatientAdapter(runtime = {}) {
  const providerKey = String(runtime?.providers?.identityProvider || "").trim();

  if (providerKey === "provider_default") {
    return assertPatientAdapter(createDefaultIdentityAdapter());
  }

  throw new Error(`Unsupported identity provider: ${providerKey}`);
}

export { createPatientAdapter };
