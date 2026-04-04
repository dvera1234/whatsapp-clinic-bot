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
import { clearTransientPortalData, sendAndSetState } from "../helpers/flowHelpers.js";
import { renderState } from "../helpers/stateRenderHelpers.js";
import { tpl } from "../helpers/contentHelpers.js";
import {
  formatPhoneFromWA,
  isValidName,
  isValidSimpleAddressField,
  nextWizardStateFromMissing,
} from "../helpers/patientHelpers.js";
import { getPromptByWizardState } from "../helpers/portalHelpers.js";
import { formatMissing } from "../helpers/patientHelpers.js";

export async function handlePatientRegistrationStep(flowCtx) {
  const {
    tenantId,
    runtime,
    traceId,
    phone,
    phoneNumberIdFallback,
    raw,
    upper,
    state,
    MSG,
    practitionerId,
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
        phoneNumberIdFallback,
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
      phoneNumberIdFallback,
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
        phoneNumberIdFallback,
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
      phoneNumberIdFallback,
    });
    await setState(tenantId, phone, "WZ_SEXO");
    return true;
  }

  if (state === "WZ_SEXO") {
    const sCurrent = await getSession(tenantId, phone);
    const lockedPlanKey =
      sCurrent?.booking?.planKey ||
      sCurrent?.portal?.form?.planKey ||
      null;

    await updateSession(tenantId, phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = sess.portal.form || {};

      if (upper === "SX_M") sess.portal.form.gender = "M";
      else if (upper === "SX_F") sess.portal.form.gender = "F";
      else sess.portal.form.gender = "NI";

      sess.portal.form.mobilePhone = formatPhoneFromWA(phone);

      if (lockedPlanKey === "PRIVATE" || lockedPlanKey === "INSURED") {
        sess.portal.form.planKey = lockedPlanKey;
      }
    });

    if (lockedPlanKey === "PRIVATE") {
      await services.sendButtons({
        tenantId,
        to: phone,
        body:
          MSG.PLAN_SELECTION_PROMPT_PRIVATE ||
          "Confirme como deseja seguir:",
        buttons: [
          {
            id: "PLAN_PRIVATE_CONFIRMED",
            title: MSG.PLAN_OPTION_PRIVATE || "Particular",
          },
          {
            id: "MENU_PRINCIPAL",
            title: MSG.MENU_BACK_TO_MAIN || "Menu principal",
          },
        ],
        phoneNumberIdFallback,
      });
      await setState(tenantId, phone, "WZ_PLANO");
      return true;
    }

    if (lockedPlanKey === "INSURED") {
      await services.sendButtons({
        tenantId,
        to: phone,
        body:
          MSG.PLAN_SELECTION_PROMPT_INSURED ||
          "Selecione o convênio desejado:",
        buttons: [
          {
            id: "PLAN_INSURED_ACCEPTED",
            title: MSG.PLAN_OPTION_INSURED || "Convênio",
          },
          {
            id: "MENU_PRINCIPAL",
            title: MSG.MENU_BACK_TO_MAIN || "Menu principal",
          },
        ],
        phoneNumberIdFallback,
      });
      await setState(tenantId, phone, "WZ_PLANO");
      return true;
    }

    await services.sendButtons({
      tenantId,
      to: phone,
      body: MSG.PLAN_SELECTION_PROMPT,
      buttons: [
        { id: "PLAN_PRIVATE", title: MSG.PLAN_OPTION_PRIVATE },
        { id: "PLAN_INSURED", title: MSG.PLAN_OPTION_INSURED },
      ],
      phoneNumberIdFallback,
    });
    await setState(tenantId, phone, "WZ_PLANO");
    return true;
  }

  if (state === "WZ_PLANO") {
    if (upper === "MENU_PRINCIPAL") {
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

    const sCurrent = await getSession(tenantId, phone);
    const lockedPlanKey =
      sCurrent?.booking?.planKey ||
      sCurrent?.portal?.form?.planKey ||
      null;

    let resolvedPlanKey = null;

    if (
      upper === "PLAN_PRIVATE" ||
      upper === "PLAN_PRIVATE_CONFIRMED"
    ) {
      resolvedPlanKey = "PRIVATE";
    } else if (
      upper === "PLAN_INSURED" ||
      upper === "PLAN_INSURED_ACCEPTED"
    ) {
      resolvedPlanKey = "INSURED";
    }

    if (!resolvedPlanKey && lockedPlanKey === "INSURED") {
      resolvedPlanKey = "INSURED";
    }

    if (!resolvedPlanKey) {
      await services.sendText({
        tenantId,
        to: phone,
        body: MSG.PICK_PLAN_BUTTONS_ONLY,
        phoneNumberIdFallback,
      });
      return true;
    }

    await updateSession(tenantId, phone, (sess) => {
      sess.portal = sess.portal || {};
      sess.portal.form = sess.portal.form || {};
      sess.portal.form.planKey = resolvedPlanKey;
      sess.portal.form.mobilePhone = formatPhoneFromWA(phone);
    });

    await sendAndSetState({
      tenantId,
      phone,
      body: MSG.ASK_EMAIL,
      state: "WZ_EMAIL",
      phoneNumberIdFallback,
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
        phoneNumberIdFallback,
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
      phoneNumberIdFallback,
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
        phoneNumberIdFallback,
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
      phoneNumberIdFallback,
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
        phoneNumberIdFallback,
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
      phoneNumberIdFallback,
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
        phoneNumberIdFallback,
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
      phoneNumberIdFallback,
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
      phoneNumberIdFallback,
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
        phoneNumberIdFallback,
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
      phoneNumberIdFallback,
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
        phoneNumberIdFallback,
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
      phoneNumberIdFallback,
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
        phoneNumberIdFallback,
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
          phoneNumberIdFallback,
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
        phoneNumberIdFallback,
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
          phoneNumberIdFallback,
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
        phoneNumberIdFallback,
      });

      const next = nextWizardStateFromMissing(validation2.missing);
      await setState(tenantId, phone, next);

      await services.sendText({
        tenantId,
        to: phone,
        body: getPromptByWizardState(next, MSG),
        phoneNumberIdFallback,
      });
      return true;
    }

    const sFinal = await getSession(tenantId, phone);
    const finalPlanKey =
      sFinal?.portal?.form?.planKey ||
      sFinal?.booking?.planKey ||
      null;

    await clearTransientPortalData(tenantId, phone);

    await finishWizardAndGoToDates({
      schedulingAdapter: adapters.schedulingAdapter,
      tenantId,
      runtime,
      phone,
      phoneNumberIdFallback,
      patientId: registeredPatientId,
      planKeyFromWizard: finalPlanKey,
      traceId,
      practitionerId,
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
    phoneNumberIdFallback,
  });
  return true;
}
