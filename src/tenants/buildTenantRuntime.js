function readString(value) {
  const v = String(value ?? "").trim();
  return v || "";
}

function readNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readDigits(value) {
  return String(value ?? "").replace(/\D+/g, "");
}

function readHttpsUrl(value) {
  const raw = readString(value);
  if (!raw) return "";

  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function buildTenantRuntime(tenantConfig = {}) {
  const schedulingProvider = readString(
    tenantConfig?.scheduling?.provider || "versatilis"
  );

  const codColaborador = readNumber(tenantConfig?.scheduling?.codColaborador);
  const codUnidade = readNumber(tenantConfig?.clinic?.codUnidade);
  const codEspecialidade = readNumber(tenantConfig?.clinic?.codEspecialidade);

  const codPlanoParticular = readNumber(
    tenantConfig?.plans?.codPlanoParticular
  );

  const codPlanoMedSeniorSp = readNumber(
    tenantConfig?.plans?.codPlanoMedSeniorSp
  );

  const portalUrl = readHttpsUrl(tenantConfig?.portal?.url);
  const supportWa = readDigits(tenantConfig?.support?.waNumber);

  const versatilisBaseUrl = readString(
    tenantConfig?.integrations?.versatilis?.baseUrl
  );
  const versatilisUser = readString(
    tenantConfig?.integrations?.versatilis?.user
  );
  const versatilisPass = readString(
    tenantConfig?.integrations?.versatilis?.pass
  );

  const missing = [];

  if (!codColaborador) missing.push("scheduling.codColaborador");
  if (!codUnidade) missing.push("clinic.codUnidade");
  if (!codEspecialidade) missing.push("clinic.codEspecialidade");
  if (!codPlanoParticular) missing.push("plans.codPlanoParticular");
  if (!codPlanoMedSeniorSp) missing.push("plans.codPlanoMedSeniorSp");
  if (!supportWa || supportWa.length < 10) missing.push("support.waNumber");

  if (schedulingProvider === "versatilis") {
    if (!versatilisBaseUrl) missing.push("integrations.versatilis.baseUrl");
    if (!versatilisUser) missing.push("integrations.versatilis.user");
    if (!versatilisPass) missing.push("integrations.versatilis.pass");
  }

  if (missing.length) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    value: {
      schedulingProvider,
      codColaborador,
      codUnidade,
      codEspecialidade,
      codPlanoParticular,
      codPlanoMedSeniorSp,
      portalUrl,
      supportWa,
      versatilis: {
        baseUrl: versatilisBaseUrl,
        user: versatilisUser,
        pass: versatilisPass,
      },
    },
  };
}
