export function createClinicAdapter({ tenantConfig }) {
  const provider = tenantConfig?.scheduling?.provider;

  if (provider === "versatilis") {
    return createVersatilisAdapter({ tenantConfig });
  }

  throw new Error(`Unsupported provider: ${provider}`);
}
