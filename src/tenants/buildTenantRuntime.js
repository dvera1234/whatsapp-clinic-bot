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

function isSupportedPatientProvider(value) {
  return ["versatilis"].includes(value);
}

function isSupportedPortalProvider(value) {
  return ["versatilis"].includes(value);
}

function isSupportedSchedulingProvider(value) {
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
  const supportWaNumber = readDigits(tenantConfig?.support?.waNumber);

  const versatilisBaseUrl = readHttpsUrl(
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

  if (!patientProvider) missing.push("integrations.patientProvider");
  if (!portalProvider) missing.push("integrations.portalProvider");
  if (!schedulingProvider) missing.push("integrations.schedulingProvider");

  if (patientProvider && !isSupportedPatientProvider(patientProvider)) {
    invalid.push("integrations.patientProvider");
  }

  if (portalProvider && !isSupportedPortalProvider(portalProvider)) {
    invalid.push("integrations.portalProvider");
  }

  if (schedulingProvider && !isSupportedSchedulingProvider(schedulingProvider)) {
    invalid.push("integrations.schedulingProvider");
  }

  pushIfMissing(missing, codColaborador === null, "clinic.codColaborador");
  pushIfMissing(missing, codUnidade === null, "clinic.codUnidade");
  pushIfMissing(missing, codEspecialidade === null, "clinic.codEspecialidade");

  pushIfMissing(
    missing,
    codPlanoParticular === null,
    "plans.codPlanoParticular"
  );

  pushIfMissing(
    missing,
    codPlanoMedSeniorSp === null,
    "plans.codPlanoMedSeniorSp"
  );

  pushIfMissing(missing, !supportWaNumber, "support.waNumber");

  if (tenantConfig?.portal?.url && !portalUrl) {
    invalid.push("portal.url");
  }

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
    pushIfMissing(missing, !versatilisUser, "integrations.versatilis.user");
    pushIfMissing(missing, !versatilisPass, "integrations.versatilis.pass");
  }

  if (schedulingProvider === "google_calendar") {
    pushIfMissing(
      missing,
      !googleCalendarId,
      "integrations.googleCalendar.calendarId"
    );
  }

  if (missing.length || invalid.length) {
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
        patient: patientProvider,
        portal: portalProvider,
        scheduling: schedulingProvider,
      },
      clinic: {
        primaryPractitionerId: codColaborador,
        defaultUnitId: codUnidade,
        defaultSpecialtyId: codEspecialidade,
      },
      plans: {
        privatePlanId: codPlanoParticular,
        insuredPlanId: codPlanoMedSeniorSp,
      },
      portal: {
        url: portalUrl,
      },
      support: {
        waNumber: supportWaNumber,
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
