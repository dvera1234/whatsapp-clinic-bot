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

function pushIfMissing(list, condition, fieldName) {
  if (condition) list.push(fieldName);
}

function isSupportedProvider(value) {
  return ["versatilis", "google_calendar"].includes(value);
}

export function buildTenantRuntime(tenantConfig = {}) {
  const tenantId = readString(tenantConfig?.tenantId);

  const patientProvider = readString(
    tenantConfig?.integrations?.patientProvider || "versatilis"
  );

  const portalProvider = readString(
    tenantConfig?.integrations?.portalProvider || "versatilis"
  );

  const schedulingProvider = readString(
    tenantConfig?.integrations?.schedulingProvider || "versatilis"
  );

  const codColaborador = readNumber(tenantConfig?.clinic?.codColaborador);
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

  const googleCalendarId = readString(
    tenantConfig?.integrations?.googleCalendar?.calendarId
  );

  const missing = [];
  const invalid = [];

  pushIfMissing(missing, !tenantId, "tenantId");

  if (!isSupportedProvider(patientProvider)) {
    invalid.push("integrations.patientProvider");
  }

  if (!isSupportedProvider(portalProvider)) {
    invalid.push("integrations.portalProvider");
  }

  if (!isSupportedProvider(schedulingProvider)) {
    invalid.push("integrations.schedulingProvider");
  }

  pushIfMissing(missing, !codColaborador, "clinic.codColaborador");
  pushIfMissing(missing, !codUnidade, "clinic.codUnidade");
  pushIfMissing(missing, !codEspecialidade, "clinic.codEspecialidade");
  pushIfMissing(missing, !codPlanoParticular, "plans.codPlanoParticular");
  pushIfMissing(missing, !codPlanoMedSeniorSp, "plans.codPlanoMedSeniorSp");
  pushIfMissing(
    missing,
    !supportWa || supportWa.length < 10,
    "support.waNumber"
  );

  const needsVersatilis =
    patientProvider === "versatilis" ||
    portalProvider === "versatilis" ||
    schedulingProvider === "versatilis";

  if (needsVersatilis) {
    pushIfMissing(
      missing,
      !versatilisBaseUrl,
      "integrations.versatilis.baseUrl"
    );
    pushIfMissing(
      missing,
      !versatilisUser,
      "integrations.versatilis.user"
    );
    pushIfMissing(
      missing,
      !versatilisPass,
      "integrations.versatilis.pass"
    );
  }

  if (schedulingProvider === "google_calendar") {
    pushIfMissing(
      missing,
      !googleCalendarId,
      "integrations.googleCalendar.calendarId"
    );
  }

  if (invalid.length || missing.length) {
    return {
      ok: false,
      missing,
      invalid,
    };
  }

  return {
    ok: true,
    value: {
      tenantId,

      providers: {
        patientProvider,
        portalProvider,
        schedulingProvider,
      },

      clinic: {
        codColaborador,
        codUnidade,
        codEspecialidade,
      },

      plans: {
        codPlanoParticular,
        codPlanoMedSeniorSp,
      },

      portal: {
        url: portalUrl,
      },

      support: {
        waNumber: supportWa,
      },

      integrations: {
        versatilis: {
          baseUrl: versatilisBaseUrl,
          user: versatilisUser,
          pass: versatilisPass,
        },
        googleCalendar: {
          calendarId: googleCalendarId,
        },
      },
    },
  };
}
