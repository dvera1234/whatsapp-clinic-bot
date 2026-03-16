import { tenantRegistry } from "./tenantRegistry.js";
import { tenantConfigs } from "./tenantConfig.js";

export function resolveTenant(phoneNumberId) {
  const tenantId = tenantRegistry[phoneNumberId];

  if (!tenantId) {
    return null;
  }

  const tenantConfig = tenantConfigs[tenantId];

  if (!tenantConfig) {
    return null;
  }

  return {
    tenantId,
    tenantConfig,
  };
}
