import { assertPatientAdapter } from "../contracts/patientAdapter.contract.js";
import { createVersatilisPatientAdapter } from "../providers/versatilis/patient/versatilisPatientAdapter.js";

function createPatientAdapter(runtime = {}) {
  const provider = String(runtime?.providers?.identityProvider || "").trim();

  if (provider === "versatilis") {
    return assertPatientAdapter(createVersatilisPatientAdapter());
  }

  throw new Error(`Unsupported identity provider: ${provider}`);
}

export { createPatientAdapter };
