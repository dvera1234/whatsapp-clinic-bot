import { tenantRegistry } from "./tenantRegistry.js";
import { tenantConfigs } from "./tenantConfig.js";

function readString(value) {
  const v = String(value ?? "").trim();
  return v || "";
}

export function resolveTenant(channelId) {
  const safeChannelId = readString(channelId);

  if (!safeChannelId) {
    return {
      ok: false,
      reason: "CHANNEL_ID_MISSING",
      tenantId: null,
      tenantConfig: null,
      channelId: "",
    };
  }

  const tenantId = tenantRegistry[safeChannelId];

  if (!tenantId) {
    return {
      ok: false,
      reason: "TENANT_NOT_FOUND_FOR_CHANNEL_ID",
      tenantId: null,
      tenantConfig: null,
      channelId: safeChannelId,
    };
  }

  const tenantConfig = tenantConfigs[tenantId];

  if (!tenantConfig) {
    return {
      ok: false,
      reason: "TENANT_CONFIG_NOT_FOUND",
      tenantId,
      tenantConfig: null,
      channelId: safeChannelId,
    };
  }

  return {
    ok: true,
    reason: null,
    tenantId,
    tenantConfig,
    channelId: safeChannelId,
  };
}
