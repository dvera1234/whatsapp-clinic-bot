import { resetToMain, sendAndSetState } from "../helpers/flowHelpers.js";

export async function handlePostFlowStep(flowCtx) {
  const {
    tenantId,
    phone,
    phoneNumberIdFallback,
    digits,
    state,
    MSG,
  } = flowCtx;

  if (state === "POS") {
    if (digits === "1") {
      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.POS_RECENTE,
        state: "POS_RECENTE",
        phoneNumberIdFallback,
      });
      return true;
    }

    if (digits === "2") {
      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.POS_TARDIO,
        state: "POS_TARDIO",
        phoneNumberIdFallback,
      });
      return true;
    }

    if (digits === "0") {
      await resetToMain(tenantId, phone, phoneNumberIdFallback, MSG);
      return true;
    }

    await sendAndSetState({
      tenantId,
      phone,
      body: MSG.POS_MENU,
      state: "POS",
      phoneNumberIdFallback,
    });
    return true;
  }

  if (state === "POS_RECENTE") {
    if (digits === "0") {
      await resetToMain(tenantId, phone, phoneNumberIdFallback, MSG);
      return true;
    }

    await sendAndSetState({
      tenantId,
      phone,
      body: MSG.POS_RECENTE,
      state: "POS_RECENTE",
      phoneNumberIdFallback,
    });
    return true;
  }

  if (state === "POS_TARDIO") {
    if (digits === "1") {
      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.PRIVATE_MENU,
        state: "PRIVATE_MENU",
        phoneNumberIdFallback,
      });
      return true;
    }

    if (digits === "2") {
      await sendAndSetState({
        tenantId,
        phone,
        body: MSG.INSURANCE_MENU,
        state: "INSURANCE_MENU",
        phoneNumberIdFallback,
      });
      return true;
    }

    if (digits === "0") {
      await resetToMain(tenantId, phone, phoneNumberIdFallback, MSG);
      return true;
    }

    await sendAndSetState({
      tenantId,
      phone,
      body: MSG.POS_TARDIO,
      state: "POS_TARDIO",
      phoneNumberIdFallback,
    });
    return true;
  }

  return false;
}
