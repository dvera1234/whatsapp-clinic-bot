import { assertPatientAdapter } from "../contracts/patientAdapter.contract.js";
import { createVersatilisPatientAdapter } from "../providers/versatilis/patient/versatilisPatientAdapter.js";

function createPatientAdapter(runtime = {}) {
  const provider = String(runtime?.providers?.patientProvider || "").trim();

  if (provider === "versatilis") {
    return assertPatientAdapter(createVersatilisPatientAdapter(runtime));
  }

  throw new Error(`Unsupported patient provider: ${provider}`);
}

export { createPatientAdapter };
