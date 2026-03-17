import { tenantRegistry } from "./tenantRegistry.js";
import { tenantConfigs } from "./tenantConfig.js";

function readString(value) {
  const v = String(value ?? "").trim();
  return v || "";
}

export function resolveTenant(phoneNumberId) {
  const safePhoneNumberId = readString(phoneNumberId);

  if (!safePhoneNumberId) {
    return {
      ok: false,
      reason: "PHONE_NUMBER_ID_MISSING",
      tenantId: null,
      tenantConfig: null,
      phoneNumberId: "",
    };
  }

  const tenantId = tenantRegistry[safePhoneNumberId];

  if (!tenantId) {
    return {
      ok: false,
      reason: "TENANT_NOT_FOUND_FOR_PHONE_NUMBER_ID",
      tenantId: null,
      tenantConfig: null,
      phoneNumberId: safePhoneNumberId,
    };
  }

  const tenantConfig = tenantConfigs[tenantId];

  if (!tenantConfig) {
    return {
      ok: false,
      reason: "TENANT_CONFIG_NOT_FOUND",
      tenantId,
      tenantConfig: null,
      phoneNumberId: safePhoneNumberId,
    };
  }

  return {
    ok: true,
    reason: null,
    tenantId,
    tenantConfig,
    phoneNumberId: safePhoneNumberId,
  };
}
