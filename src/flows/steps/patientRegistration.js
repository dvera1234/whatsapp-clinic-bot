import {
  getSession,
  setState,
  updateSession,
} from "../../session/redisSession.js";
import {
  cleanStr,
  isValidEmail,
  normalizeCEP,
  normalizeHumanText,
} from "../../utils/validators.js";
import { parseBRDateToISO } from "../../utils/time.js";
import { maskPhone } from "../../utils/mask.js";
import {
  handleProviderTemporaryUnavailable,
  isProviderTemporaryUnavailableError,
} from "../helpers/auditHelpers.js";
import { finishWizardAndGoToDates } from "../helpers/bookingHelpers.js";
import {
  clearTransientPortalData,
  sendAndSetState,
} from "../helpers/flowHelpers.js";
import { renderState } from "../helpers/stateRenderHelpers.js";
import { tpl } from "../helpers/contentHelpers.js";
import {
  formatPhoneFromWA,
  isValidName,
  isValidSimpleAddressField,
  nextWizardStateFromMissing,
  formatMissing,
} from "../helpers/patientHelpers.js";
import { getPromptByWizardState } from "../helpers/portalHelpers.js";
import { sendListMessage } from "../../whatsapp/sendListMessage.js";

function getWizardSelectablePlans(runtime) {
  const plans = Array.isArray(runtime?.content?.plans)
    ? runtime.content.plans
    : [];

  const flowMap =
    runtime?.content?.flows && typeof runtime.content.flows === "object"
      ? runtime.content.flows
      : {};

  return plans.filter((plan) => {
    const flowKey = String(plan?.flow || "").trim();
    const flowType = String(flowMap?.[flowKey]?.type || "")
      .trim()
      .toUpperCase();

    return flowType === "BOOKING" || flowType === "CONTINUE";
  });
}

function getPlanById(runtime, planId) {
  const normalizedPlanId = String(planId || "").trim();
  if (!normalizedPlanId) return null;

  const plans = Array.isArray(runtime?.content?.plans)
    ? runtime.content.plans
    : [];

  return (
    plans.find(
      (plan) => String(plan?.id || "").trim() === normalizedPlanId
    ) || null
  );
}

function getLockedPlan(runtime, session) {
  const bookingPlanId = String(session?.booking?.planId || "").trim();
  if (bookingPlanId) {
    const byBookingPlanId = getPlanById(runtime, bookingPlanId);
    if (byBookingPlanId) return byBookingPlanId;
  }

  const portalPlanId = String(session?.portal?.form?.planId || "").trim();
  if (portalPlanId) {
    const byPortalPlanId = getPlanById(runtime, portalPlanId);
    if (byPortalPlanId) return byPortalPlanId;
  }

  return null;
}

function getPractitionerConfig(plan) {
  const practitionerMode = String(
    plan?.booking?.practitionerMode || ""
  ).trim().toUpperCase();

  const practitionerIds = Array.isArray(plan?.booking?.practitionerIds)
    ? plan.booking.practitionerIds
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    : [];

  return {
    practitionerMode,
    practitionerIds,
  };
}

function getFixedPractitionerId(plan) {
  const { practitionerMode, practitionerIds } = getPractitionerConfig(plan);

  if (practitionerMode !== "FIXED") return null;
  if (practitionerIds.length !== 1) return null;

  return practitionerIds[0];
}

function applySelectedPlanToSession(sess, plan) {
  const { practitionerMode, practitionerIds } = getPractitionerConfig(plan);
  const fixedPractitionerId = getFixedPractitionerId(plan);

  sess.portal = sess.portal || {};
  sess.portal.form = sess.portal.form || {};
  sess.portal.form.planId = String(plan?.id || "").trim();
  sess.portal.form.planKey = String(plan?.key || "").trim();

  sess.booking = sess.booking || {};
  sess.booking.planId = String(plan?.id || "").trim();
  sess.booking.planKey = String(plan?.key || "").trim();
  sess.booking.planFlow = String(plan?.flow || "").trim() || null;
  sess.booking.planLabel = String(plan?.label || "").trim() || null;
  sess.booking.planMessageKey =
    String(plan?.messageKey || "").trim() || null;
  sess.booking.planNextState =
    String(plan?.nextState || "").trim() || null;

  sess.booking.practitionerMode = practitionerMode || null;
  sess.booking.practitionerIds = practitionerIds;

  if (fixedPractitionerId) {
    sess.booking.practitionerId = fixedPractitionerId;
  } else {
    delete sess.booking.practitionerId;
  }
}

function buildPlanListSections(plans) {
  const rows = plans.map((plan) => ({
    id: `WZ_PLAN:${String(plan?.id || "").trim()}`,
    title: String(plan?.label || "").trim() || String(plan?.key || "").trim(),
    description: "",
  }));

  rows.push({
    id: "WZ_PLAN:MENU_PRINCIPAL",
    title: "Menu principal",
    description: "",
  });

  const sections = [];
  for (let i = 0; i < rows.length; i += 10) {
    sections.push({
      title: i === 0 ? "Planos" : `Planos ${Math.floor(i / 10) + 1}`,
      rows: rows.slice(i, i + 10),
    });
  }

  return sections;
}

async function renderWizardPlanSelection({
  tenantId,
  phone,
  phoneNumberId,
  runtime,
  services,
  MSG,
  selectablePlans,
}) {
  if (selectablePlans.length <= 3) {
    await services.sendButtons({
      tenantId,
      to: phone,
      body:
        runtime?.content?.messages?.planSelectionPrompt ||
        MSG?.PLAN_SELECTION_PROMPT ||
        "Selecione o plano para continuar:",
      buttons: selectablePlans.map((plan) => ({
        id: `WZ_PLAN:${String(plan?.id || "").trim()}`,
        title:
          String(plan?.label || "").trim() ||
          String(plan?.key || "").trim(),
      })),
      phoneNumberId,
    });
    return;
  }

  await sendListMessage({
    tenantId,
    to: phone,
    phoneNumberId,
    body:
      runtime?.content?.messages?.planSelectionPrompt ||
      MSG?.PLAN_SELECTION_PROMPT ||
      "Selecione o plano para continuar:",
    buttonText:
      runtime?.content?.messages?.bookingOptionsButton ||
      runtime?.content?.messages?.lgpdButtonText ||
      "Selecionar",
    sections: buildPlanListSections(selectablePlans),
  });
}

function resolveSelectedWizardPlan(runtime, raw, upper) {
  const rawValue = String(raw || "").trim();
  const upperValue = String(upper || "").trim();

  const rawMatch = /^WZ_PLAN:(.+)$/.exec(rawValue);
  if (rawMatch?.[1]) {
    return getPlanById(runtime, rawMatch[1]);
  }

  const upperMatch = /^WZ_PLAN:(.+)$/.exec(upperValue);
  if (upperMatch?.[1]) {
    return getPlanById(runtime, upperMatch[1]);
  }

  return null;
}

function isWizardBackToMain(raw, upper) {
  const rawValue = String(raw || "").trim();
  const upperValue = String(upper || "").trim();

  return (
    rawValue === "WZ_PLAN:MENU_PRINCIPAL" ||
    upperValue === "WZ_PLAN:MENU_PRINCIPAL" ||
    upperValue === "MENU_PRINCIPAL"
  );
}

export async function handlePatientRegistrationStep(flowCtx) {
  const {
    tenantId,
    runtime,
    traceId,
    phone,
    phoneNumberId,
    raw,
    upper,
    state,
    MSG,
    runtimeCtx,
    adapters,
    services,
  } = flowCtx;

  if (!String(state || "").startsWith("WZ_") || state === "WZ_CPF") {
    return false;
  }

  if (state === "WZ_NOME") {
    const fullName = normalizeHumanText(raw, 120);

    if (!isValidName(fullName)) {
      await services.sendText({
        tenantId,
        to: phone,
        body: MSG.NAME_INVALID,
        phoneNumberId,
      });
      return true;
    }

    await updateSession(tenantId, phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = sess.portal.form || {};
      sess.portal.form.fullName = fullName;
    });

    await sendAndSetState({
      tenantId,
      phone,
      body: MSG.ASK_DTNASC,
      state: "WZ_DTNASC",
      phoneNumberId,
    });
    return true;
  }

  if (state === "WZ_DTNASC") {
    const birthDateISO = parseBRDateToISO(raw);

    if (!birthDateISO) {
      await services.sendText({
        tenantId,
        to: phone,
        body: MSG.DATE_INVALID,
        phoneNumberId,
      });
      return true;
    }

    await updateSession(tenantId, phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = sess.portal.form || {};
      sess.portal.form.birthDateISO = birthDateISO;
    });

    await services.sendButtons({
      tenantId,
      to: phone,
      body: MSG.SEX_PROMPT,
      buttons: [
        { id: "SX_M", title: MSG.SEX_MALE },
        { id: "SX_F", title: MSG.SEX_FEMALE },
        { id: "SX_NI", title: MSG.SEX_NO_INFO },
      ],
      phoneNumberId,
    });

    await setState(tenantId, phone, "WZ_SEXO");
    return true;
  }

  if (state === "WZ_SEXO") {
    if (!["SX_M", "SX_F", "SX_NI"].includes(String(upper || "").trim())) {
      await services.sendText({
        tenantId,
        to: phone,
        body:
          runtime?.content?.messages?.buttonsOnlyWarning ||
          MSG?.BUTTONS_ONLY_WARNING,
        phoneNumberId,
      });
      return true;
    }

    const sCurrent = await getSession(tenantId, phone);
    const lockedPlan = getLockedPlan(runtime, sCurrent);

    await updateSession(tenantId, phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = sess.portal.form || {};

      if (upper === "SX_M") sess.portal.form.gender = "M";
      else if (upper === "SX_F") sess.portal.form.gender = "F";
      else sess.portal.form.gender = "NI";

      sess.portal.form.mobilePhone = formatPhoneFromWA(phone);

      if (lockedPlan) {
        applySelectedPlanToSession(sess, lockedPlan);
      }
    });

    if (lockedPlan) {
      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.ASK_EMAIL,
        state: "WZ_EMAIL",
        phoneNumberId,
      });
      return true;
    }

    const selectablePlans = getWizardSelectablePlans(runtime);

    if (!selectablePlans.length) {
      throw new Error("TENANT_CONTENT_INVALID:wizard_plans_empty");
    }

    if (selectablePlans.length === 1) {
      await updateSession(tenantId, phone, (sess) => {
        applySelectedPlanToSession(sess, selectablePlans[0]);
      });

      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.ASK_EMAIL,
        state: "WZ_EMAIL",
        phoneNumberId,
      });
      return true;
    }

    await renderWizardPlanSelection({
      tenantId,
      phone,
      phoneNumberId,
      runtime,
      services,
      MSG,
      selectablePlans,
    });

    await setState(tenantId, phone, "WZ_PLANO");
    return true;
  }

  if (state === "WZ_PLANO") {
    if (isWizardBackToMain(raw, upper)) {
      await clearTransientPortalData(tenantId, phone);
      await setState(tenantId, phone, "MAIN");
      await renderState({
        ...flowCtx,
        state: "MAIN",
        raw: "",
        upper: "",
        digits: "",
      });
      return true;
    }

    const selectedPlan = resolveSelectedWizardPlan(runtime, raw, upper);

    if (!selectedPlan) {
      await services.sendText({
        tenantId,
        to: phone,
        body:
          runtime?.content?.messages?.pickPlanButtonsOnly ||
          MSG?.PICK_PLAN_BUTTONS_ONLY,
        phoneNumberId,
      });
      return true;
    }

    await updateSession(tenantId, phone, (sess) => {
      applySelectedPlanToSession(sess, selectedPlan);
      sess.portal = sess.portal || {};
      sess.portal.form = sess.portal.form || {};
      sess.portal.form.mobilePhone = formatPhoneFromWA(phone);
    });

    await sendAndSetState({
      tenantId,
      phone,
      body: MSG.ASK_EMAIL,
      state: "WZ_EMAIL",
      phoneNumberId,
    });
    return true;
  }

  if (state === "WZ_EMAIL") {
    const email = cleanStr(raw);

    if (!isValidEmail(email)) {
      await services.sendText({
        tenantId,
        to: phone,
        body: MSG.EMAIL_INVALID,
        phoneNumberId,
      });
      return true;
    }

    await updateSession(tenantId, phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = sess.portal.form || {};
      sess.portal.form.email = email;
    });

    await sendAndSetState({
      tenantId,
      phone,
      body: MSG.ASK_CEP,
      state: "WZ_CEP",
      phoneNumberId,
    });
    return true;
  }

  if (state === "WZ_CEP") {
    const postalCode = normalizeCEP(raw);

    if (postalCode.length !== 8) {
      await services.sendText({
        tenantId,
        to: phone,
        body: MSG.CEP_INVALID,
        phoneNumberId,
      });
      return true;
    }

    await updateSession(tenantId, phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = sess.portal.form || {};
      sess.portal.form.postalCode = postalCode;
    });

    await sendAndSetState({
      tenantId,
      phone,
      body: MSG.ASK_ENDERECO,
      state: "WZ_ENDERECO",
      phoneNumberId,
    });
    return true;
  }

  if (state === "WZ_ENDERECO") {
    const streetAddress = normalizeHumanText(raw, 120);

    if (!isValidSimpleAddressField(streetAddress, 3, 120)) {
      await services.sendText({
        tenantId,
        to: phone,
        body: MSG.ADDRESS_INVALID,
        phoneNumberId,
      });
      return true;
    }

    await updateSession(tenantId, phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = sess.portal.form || {};
      sess.portal.form.streetAddress = streetAddress;
    });

    await sendAndSetState({
      tenantId,
      phone,
      body: MSG.ASK_NUMERO,
      state: "WZ_NUMERO",
      phoneNumberId,
    });
    return true;
  }

  if (state === "WZ_NUMERO") {
    const addressNumber = normalizeHumanText(raw, 20);

    if (!addressNumber) {
      await services.sendText({
        tenantId,
        to: phone,
        body: MSG.ADDRESS_NUMBER_INVALID,
        phoneNumberId,
      });
      return true;
    }

    await updateSession(tenantId, phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = sess.portal.form || {};
      sess.portal.form.addressNumber = addressNumber;
    });

    await sendAndSetState({
      tenantId,
      phone,
      body: MSG.ASK_COMPLEMENTO,
      state: "WZ_COMPLEMENTO",
      phoneNumberId,
    });
    return true;
  }

  if (state === "WZ_COMPLEMENTO") {
    const addressComplement = normalizeHumanText(raw, 80) || "0";

    await updateSession(tenantId, phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = sess.portal.form || {};
      sess.portal.form.addressComplement = addressComplement;
    });

    await sendAndSetState({
      tenantId,
      phone,
      body: MSG.ASK_BAIRRO,
      state: "WZ_BAIRRO",
      phoneNumberId,
    });
    return true;
  }

  if (state === "WZ_BAIRRO") {
    const district = normalizeHumanText(raw, 80);

    if (!isValidSimpleAddressField(district, 2, 80)) {
      await services.sendText({
        tenantId,
        to: phone,
        body: MSG.DISTRICT_INVALID,
        phoneNumberId,
      });
      return true;
    }

    await updateSession(tenantId, phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = sess.portal.form || {};
      sess.portal.form.district = district;
    });

    await sendAndSetState({
      tenantId,
      phone,
      body: MSG.ASK_CIDADE,
      state: "WZ_CIDADE",
      phoneNumberId,
    });
    return true;
  }

  if (state === "WZ_CIDADE") {
    const city = normalizeHumanText(raw, 80);

    if (!isValidSimpleAddressField(city, 2, 80)) {
      await services.sendText({
        tenantId,
        to: phone,
        body: MSG.CITY_INVALID,
        phoneNumberId,
      });
      return true;
    }

    await updateSession(tenantId, phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = sess.portal.form || {};
      sess.portal.form.city = city;
    });

    await sendAndSetState({
      tenantId,
      phone,
      body: MSG.ASK_UF,
      state: "WZ_UF",
      phoneNumberId,
    });
    return true;
  }

  if (state === "WZ_UF") {
    const stateCode = cleanStr(raw).toUpperCase();

    if (!/^[A-Z]{2}$/.test(stateCode)) {
      await services.sendText({
        tenantId,
        to: phone,
        body: MSG.UF_INVALID,
        phoneNumberId,
      });
      return true;
    }

    await updateSession(tenantId, phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = sess.portal.form || {};
      sess.portal.form.stateCode = stateCode;
    });

    const sUpdated = await getSession(tenantId, phone);

    let registrationResult;
    try {
      registrationResult = await adapters.portalAdapter.createPatientRegistration({
        registrationData: sUpdated?.portal?.form || {},
        traceMeta: {
          tenantId,
          traceId,
          tracePhone: maskPhone(phone),
          flow: "PATIENT_REGISTRATION_WIZARD_CREATE",
        },
        runtimeCtx,
      });
    } catch (err) {
      if (isProviderTemporaryUnavailableError(err)) {
        await handleProviderTemporaryUnavailable({
          tenantId,
          traceId,
          phone,
          phoneNumberId,
          capability: "access",
          err,
          MSG,
          nextState: "MAIN",
          services,
        });
        return true;
      }
      throw err;
    }

    const registeredPatientId =
      registrationResult?.ok &&
      Number(registrationResult?.data?.patientId) > 0
        ? Number(registrationResult.data.patientId)
        : null;

    if (!registrationResult.ok || !registeredPatientId) {
      await services.sendText({
        tenantId,
        to: phone,
        body: MSG.REGISTRATION_CREATE_FAILURE,
        phoneNumberId,
      });
      await setState(tenantId, phone, "MAIN");
      return true;
    }

    let profileResult2;
    try {
      profileResult2 = await adapters.patientAdapter.getPatientProfile({
        patientId: registeredPatientId,
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

    const validation2Result = profileResult2.ok
      ? adapters.patientAdapter.validateRegistrationData({
          profile: profileResult2.data,
        })
      : null;

    const validation2 =
      validation2Result?.ok && validation2Result?.data
        ? validation2Result.data
        : { ok: false, missing: ["dados do cadastro"] };

    if (!validation2.ok) {
      await services.sendText({
        tenantId,
        to: phone,
        body: tpl(MSG.PORTAL_NEED_DATA, {
          faltas: formatMissing(validation2.missing),
        }),
        phoneNumberId,
      });

      const next = nextWizardStateFromMissing(validation2.missing);
      await setState(tenantId, phone, next);

      await services.sendText({
        tenantId,
        to: phone,
        body: getPromptByWizardState(next, MSG),
        phoneNumberId,
      });
      return true;
    }

    const sFinal = await getSession(tenantId, phone);
    const finalPlanKey =
      String(sFinal?.portal?.form?.planKey || "").trim() ||
      String(sFinal?.booking?.planKey || "").trim() ||
      null;

    const finalPlanId =
      String(sFinal?.portal?.form?.planId || "").trim() ||
      String(sFinal?.booking?.planId || "").trim() ||
      null;

    const finalPlan =
      getPlanById(runtime, finalPlanId) ||
      getWizardSelectablePlans(runtime).find(
        (plan) => String(plan?.key || "").trim() === finalPlanKey
      ) ||
      null;

    const finalPractitionerId = getFixedPractitionerId(finalPlan);

    await clearTransientPortalData(tenantId, phone);

    await finishWizardAndGoToDates({
      schedulingAdapter: adapters.schedulingAdapter,
      tenantId,
      runtime,
      phone,
      phoneNumberId,
      patientId: registeredPatientId,
      planKeyFromWizard: finalPlanKey,
      traceId,
      practitionerId: finalPractitionerId,
      MSG,
      services,
    });

    return true;
  }

  await sendAndSetState({
    tenantId,
    phone,
    body: MSG.ASK_CPF_PORTAL,
    state: "WZ_CPF",
    phoneNumberId,
  });
  return true;
}
