import { loadTenantConfigByPhoneNumberId } from "../db/loadTenantConfigByPhoneNumberId.js";
import { buildTenantRuntime } from "./buildTenantRuntime.js";

function readString(value) {
  return String(value ?? "").trim();
}

export async function resolveTenant(phoneNumberId) {
  const safePhoneNumberId = readString(phoneNumberId);

  if (!safePhoneNumberId) {
    return {
      ok: false,
      reason: "PHONE_NUMBER_ID_MISSING",
      tenantId: null,
      runtime: null,
      phoneNumberId: "",
      missing: [],
      invalid: [],
    };
  }

  const tenantConfig = await loadTenantConfigByPhoneNumberId(safePhoneNumberId);

  if (!tenantConfig) {
    return {
      ok: false,
      reason: "TENANT_NOT_FOUND_FOR_PHONE_NUMBER_ID",
      tenantId: null,
      runtime: null,
      phoneNumberId: safePhoneNumberId,
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
      phoneNumberId: safePhoneNumberId,
      missing: Array.isArray(built?.missing) ? built.missing : [],
      invalid: Array.isArray(built?.invalid) ? built.invalid : [],
    };
  }

  return {
    ok: true,
    reason: null,
    tenantId: built.value.tenantId,
    runtime: built.value,
    phoneNumberId: safePhoneNumberId,
    missing: [],
    invalid: [],
  };
}
