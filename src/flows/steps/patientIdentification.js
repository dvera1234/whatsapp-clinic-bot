import {
  getSession,
  setState,
  updateSession,
} from "../../session/redisSession.js";
import {
  LGPD_TEXT_VERSION,
  LGPD_TEXT_HASH,
} from "../../config/constants.js";
import {
  onlyCpfDigits,
  cleanStr,
  isValidEmail,
} from "../../utils/validators.js";
import { parseBRDateToISO } from "../../utils/time.js";
import { sanitizeForLog } from "../../utils/logSanitizer.js";
import { audit, debugLog } from "../../observability/audit.js";
import { maskCpf, maskPhone } from "../../utils/mask.js";
import {
  handleProviderTemporaryUnavailable,
  isProviderTemporaryUnavailableError,
} from "../helpers/auditHelpers.js";
import { finishWizardAndGoToDates } from "../helpers/bookingHelpers.js";
import { tpl } from "../helpers/contentHelpers.js";
import { formatMissing } from "../helpers/patientHelpers.js";

function getPlanByKey(runtime, planKey) {
  const normalizedPlanKey = String(planKey || "").trim();
  if (!normalizedPlanKey) return null;

  const plans = Array.isArray(runtime?.content?.plans)
    ? runtime.content.plans
    : [];

  return (
    plans.find(
      (plan) => String(plan?.key || "").trim() === normalizedPlanKey
    ) || null
  );
}

function getSelectedPlanKeyFromSession(session) {
  const bookingPlanKey = String(session?.booking?.planKey || "").trim();
  if (bookingPlanKey) return bookingPlanKey;

  const portalPlanKey = String(session?.portal?.form?.planKey || "").trim();
  if (portalPlanKey) return portalPlanKey;

  return null;
}

function getFixedPractitionerIdFromPlan(plan) {
  const practitionerMode = String(
    plan?.booking?.practitionerMode || ""
  ).trim().toUpperCase();

  const practitionerIds = Array.isArray(plan?.booking?.practitionerIds)
    ? plan.booking.practitionerIds
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    : [];

  if (practitionerMode !== "FIXED") return null;
  if (practitionerIds.length !== 1) return null;

  return practitionerIds[0];
}

export async function handlePatientIdentificationStep(flowCtx) {
  const {
    tenantId,
    runtime,
    traceId,
    phone,
    phoneNumberId,
    raw,
    state,
    MSG,
    runtimeCtx,
    adapters,
    services,
  } = flowCtx;

  if (state !== "WZ_CPF") return false;

  let s = await getSession(tenantId, phone);

  if (!s.portal) {
    await updateSession(tenantId, phone, (sess) => {
      sess.portal = { patientId: null, exists: false, form: {} };
    });
    s = await getSession(tenantId, phone);
  }

  if (!s.portal.form) {
    await updateSession(tenantId, phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = {};
    });
  }

  const document = onlyCpfDigits(raw);

  if (!document) {
    await services.sendText({
      tenantId,
      to: phone,
      body:
        runtime?.content?.messages?.cpfInvalido ||
        MSG?.CPF_INVALIDO,
      phoneNumberId,
    });
    return true;
  }

  audit("LGPD_CONSENT_CONFIRMED_BY_IDENTIFICATION", {
    tenantId,
    traceId,
    tracePhone: maskPhone(phone),
    cpfMasked: maskCpf(document),
    consentTextVersion: LGPD_TEXT_VERSION,
    consentTextHash: LGPD_TEXT_HASH,
    timestamp: new Date().toISOString(),
  });

  debugLog(
    "PATIENT_DOCUMENT_RECEIVED_FOR_IDENTIFICATION",
    sanitizeForLog({
      tenantId,
      traceId,
      tracePhone: maskPhone(phone),
      documentMasked: "***",
    })
  );

  let patientIdResult;
  try {
    patientIdResult = await adapters.patientAdapter.findPatientIdByDocument({
      document,
      runtimeCtx,
    });
  } catch (err) {
    if (isProviderTemporaryUnavailableError(err)) {
      await handleProviderTemporaryUnavailable({
        tenantId,
        traceId,
        phone,
        phoneNumberId,
        capability: "identity",
        err,
        MSG,
        nextState: "MAIN",
        services,
      });
      return true;
    }
    throw err;
  }

  const patientId =
    patientIdResult?.ok && Number(patientIdResult?.data?.patientId) > 0
      ? Number(patientIdResult.data.patientId)
      : null;

  debugLog(
    "PATIENT_DOCUMENT_IDENTIFICATION_RESULT",
    sanitizeForLog({
      tenantId,
      traceId,
      tracePhone: maskPhone(phone),
      documentMasked: "***",
      patientIdFound: !!patientId,
      patientId: patientId || null,
      httpStatus: patientIdResult?.status || null,
      rid: patientIdResult?.rid || null,
    })
  );

  if (!patientId) {
    await updateSession(tenantId, phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.exists = false;
      sess.portal.form = sess.portal.form || {};
      sess.portal.form.document = document;
      sess.portal.patientId = null;

      sess.booking = sess.booking || {};
      delete sess.booking.patientId;
    });

    await services.sendText({
      tenantId,
      to: phone,
      body:
        runtime?.content?.messages?.wizardNewPatientName ||
        MSG?.WIZARD_NEW_PATIENT_NAME,
      phoneNumberId,
    });

    await setState(tenantId, phone, "WZ_NOME");
    return true;
  }

  await updateSession(tenantId, phone, (sess) => {
    sess.portal = sess.portal || {};
    sess.portal.form = sess.portal.form || {};
    sess.portal.form.document = document;
    sess.portal.exists = true;
    sess.portal.patientId = patientId;

    sess.booking = sess.booking || {};
    sess.booking.patientId = patientId;
  });

  let profileResult;
  try {
    profileResult = await adapters.patientAdapter.getPatientProfile({
      patientId,
      runtimeCtx,
    });
  } catch (err) {
    if (isProviderTemporaryUnavailableError(err)) {
      await handleProviderTemporaryUnavailable({
        tenantId,
        traceId,
        phone,
        phoneNumberId,
        capability: "identity",
        err,
        MSG,
        nextState: "MAIN",
        services,
      });
      return true;
    }
    throw err;
  }

  if (!profileResult.ok || !profileResult.data) {
    await services.sendText({
      tenantId,
      to: phone,
      body:
        runtime?.content?.messages?.profileLookupFailure ||
        MSG?.PROFILE_LOOKUP_FAILURE,
      phoneNumberId,
    });
    await setState(tenantId, phone, "MAIN");
    return true;
  }

  const profile = profileResult.data;

  await updateSession(tenantId, phone, (sess) => {
    sess.portal = sess.portal || {};
    sess.portal.form = sess.portal.form || {};

    const fullName = cleanStr(profile?.Nome);
    if (fullName && !sess.portal.form.fullName) {
      sess.portal.form.fullName = fullName;
    }

    const email = cleanStr(profile?.Email);
    if (isValidEmail(email) && !sess.portal.form.email) {
      sess.portal.form.email = email;
    }

    const mobilePhone = cleanStr(profile?.Celular).replace(/\D+/g, "");
    if (mobilePhone.length >= 10 && !sess.portal.form.mobilePhone) {
      sess.portal.form.mobilePhone = mobilePhone;
    }

    const phoneNumber = cleanStr(profile?.Telefone).replace(/\D+/g, "");
    if (phoneNumber.length >= 10 && !sess.portal.form.phone) {
      sess.portal.form.phone = phoneNumber;
    }

    const postalCode = String(profile?.CEP ?? "").replace(/\D+/g, "");
    if (postalCode.length === 8 && !sess.portal.form.postalCode) {
      sess.portal.form.postalCode = postalCode;
    }

    const streetAddress = cleanStr(profile?.Endereco);
    if (streetAddress && !sess.portal.form.streetAddress) {
      sess.portal.form.streetAddress = streetAddress;
    }

    const addressNumber = cleanStr(profile?.Numero);
    if (addressNumber && !sess.portal.form.addressNumber) {
      sess.portal.form.addressNumber = addressNumber;
    }

    const addressComplement = cleanStr(profile?.Complemento);
    if (addressComplement && !sess.portal.form.addressComplement) {
      sess.portal.form.addressComplement = addressComplement;
    }

    const district = cleanStr(profile?.Bairro);
    if (district && !sess.portal.form.district) {
      sess.portal.form.district = district;
    }

    const city = cleanStr(profile?.Cidade);
    if (city && !sess.portal.form.city) {
      sess.portal.form.city = city;
    }

    const birthDateRaw = cleanStr(profile?.DtNasc);
    let birthDateISO = parseBRDateToISO(birthDateRaw) || null;

    if (!birthDateISO) {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(birthDateRaw);
      if (m) birthDateISO = `${m[1]}-${m[2]}-${m[3]}`;
    }

    if (birthDateISO && !sess.portal.form.birthDateISO) {
      sess.portal.form.birthDateISO = birthDateISO;
    }
  });

  const validationResult = adapters.patientAdapter.validateRegistrationData({
    profile,
  });

  const validation =
    validationResult?.ok && validationResult?.data
      ? validationResult.data
      : { ok: false, missing: ["dados do cadastro"] };

  if (validation.ok) {
    const sCurrent = await getSession(tenantId, phone);
    const selectedPlanKey = getSelectedPlanKeyFromSession(sCurrent);
    const selectedPlan = getPlanByKey(runtime, selectedPlanKey);
    const practitionerId = getFixedPractitionerIdFromPlan(selectedPlan);

    await finishWizardAndGoToDates({
      schedulingAdapter: adapters.schedulingAdapter,
      tenantId,
      runtime,
      phone,
      phoneNumberId,
      patientId,
      planKeyFromWizard: selectedPlanKey,
      traceId,
      practitionerId,
      MSG,
      services,
    });

    return true;
  }

  await updateSession(tenantId, phone, (sess) => {
    sess.portal = sess.portal || {};
    sess.portal.missing = validation.missing;
  });

  audit(
    "EXISTING_PATIENT_BLOCKED_INCOMPLETE_REGISTRATION",
    sanitizeForLog({
      tenantId,
      traceId,
      tracePhone: maskPhone(phone),
      patientId: patientId || null,
      missingFields: Array.isArray(validation.missing)
        ? validation.missing
        : [],
      escalationRequired: true,
    })
  );

  await services.sendButtons({
    tenantId,
    to: phone,
    body: tpl(
      runtime?.content?.messages?.portalExistenteIncompletoBloqueio ||
        MSG?.PORTAL_EXISTENTE_INCOMPLETO_BLOQUEIO,
      {
        faltas: formatMissing(validation.missing),
      }
    ),
    buttons: [
      {
        id: "FALAR_ATENDENTE",
        title:
          runtime?.content?.messages?.btnFalarAtendente ||
          MSG?.BTN_FALAR_ATENDENTE,
      },
    ],
    phoneNumberId,
  });

  await setState(tenantId, phone, "BLOCK_EXISTING_INCOMPLETE");
  return true;
}
