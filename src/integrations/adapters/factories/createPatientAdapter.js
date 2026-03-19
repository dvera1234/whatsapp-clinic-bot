import { assertPatientAdapter } from "../contracts/patientAdapter.contract.js";
import { createVersatilisPatientAdapter } from "../providers/versatilis/patient/versatilisPatientAdapter.js";

function createPatientAdapter(runtime = {}) {
  const providerKey = String(
    runtime?.providers?.identity ||
      runtime?.providers?.patient ||
      runtime?.providers?.patientProvider ||
      ""
  ).trim();

  if (providerKey === "versatilis") {
    return assertPatientAdapter(createVersatilisPatientAdapter());
  }

  throw new Error(`Unsupported identity provider: ${providerKey}`);
}

export { createPatientAdapter };
