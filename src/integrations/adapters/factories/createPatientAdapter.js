import { assertPatientAdapter } from "../contracts/patientAdapter.contract.js";
import { createVersatilisPatientAdapter } from "../providers/versatilis/patient/versatilisPatientAdapter.js";

function createPatientAdapter({ tenantConfig }) {
  const provider = String(
    tenantConfig?.integrations?.patientProvider || ""
  ).trim();

  if (provider === "versatilis") {
    return assertPatientAdapter(createVersatilisPatientAdapter({ tenantConfig }));
  }

  throw new Error(`Unsupported patient provider: ${provider}`);
}

export { createPatientAdapter };
