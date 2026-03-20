import { assertPatientAdapter } from "../contracts/patientAdapter.contract.js";
import { createVersatilisPatientAdapter } from "../providers/versatilis/patient/versatilisPatientAdapter.js";

function createPatientAdapter(runtime = {}) {
  const providerKey = String(runtime?.providers?.identity || "").trim();

  if (!providerKey) {
    throw new Error("Missing provider: providers.identity");
  }

  if (providerKey === "versatilis") {
    return assertPatientAdapter(createVersatilisPatientAdapter());
  }

  throw new Error(`Unsupported identity provider: ${providerKey}`);
}

export { createPatientAdapter };
