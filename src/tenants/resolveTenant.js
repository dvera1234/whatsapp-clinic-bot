import { tenantRegistry } from "./tenantRegistry.js";
import { tenantConfigs } from "./tenantConfig.js";

export function resolveTenant(phoneNumberId) {
  const safePhoneNumberId = String(phoneNumberId || "").trim();
  if (!safePhoneNumberId) {
    return null;
  }

  const tenantId = tenantRegistry[safePhoneNumberId];
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
