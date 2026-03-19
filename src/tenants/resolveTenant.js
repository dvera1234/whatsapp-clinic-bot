import { loadTenantConfigByPhoneNumberId } from "../db/loadTenantConfigByPhoneNumberId.js";

function readString(value) {
  const v = String(value ?? "").trim();
  return v || "";
}

export async function resolveTenant(channelId) {
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

  const tenantConfig = await loadTenantConfigByPhoneNumberId(safeChannelId);

  if (!tenantConfig) {
    return {
      ok: false,
      reason: "TENANT_NOT_FOUND_FOR_CHANNEL_ID",
      tenantId: null,
      tenantConfig: null,
      channelId: safeChannelId,
    };
  }

  return {
    ok: true,
    reason: null,
    tenantId: tenantConfig.tenantId,
    tenantConfig,
    channelId: safeChannelId,
  };
}
