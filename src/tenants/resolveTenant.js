import { loadTenantConfigByPhoneNumberId } from "../db/loadTenantConfigByPhoneNumberId.js";
import { buildTenantRuntime } from "./buildTenantRuntime.js";

function readString(value) {
  return String(value ?? "").trim();
}

export async function resolveTenant(channelId) {
  const safeChannelId = readString(channelId);

  if (!safeChannelId) {
    return {
      ok: false,
      reason: "CHANNEL_ID_MISSING",
      tenantId: null,
      runtime: null,
      channelId: "",
      missing: [],
      invalid: [],
    };
  }

  const tenantConfig = await loadTenantConfigByPhoneNumberId(safeChannelId);

  if (!tenantConfig) {
    return {
      ok: false,
      reason: "TENANT_NOT_FOUND_FOR_CHANNEL_ID",
      tenantId: null,
      runtime: null,
      channelId: safeChannelId,
      missing: [],
      invalid: [],
    };
  }

  const built = buildTenantRuntime(tenantConfig);

  if (!built?.ok || !built?.value) {
    return {
      ok: false,
      reason: "TENANT_RUNTIME_INVALID",
      tenantId: tenantConfig?.tenantId || null,
      runtime: null,
      channelId: safeChannelId,
      missing: Array.isArray(built?.missing) ? built.missing : [],
      invalid: Array.isArray(built?.invalid) ? built.invalid : [],
    };
  }

  return {
    ok: true,
    reason: null,
    tenantId: built.value.tenantId,
    runtime: built.value,
    channelId: safeChannelId,
    missing: [],
    invalid: [],
  };
}
