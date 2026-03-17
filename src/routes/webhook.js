import express from "express";
import crypto from "crypto";

import { getState, redis } from "../session/redisSession.js";
import { VERIFY_TOKEN } from "../config/env.js";
import { LGPD_TEXT_HASH, LGPD_TEXT_VERSION } from "../config/constants.js";
import { audit, errLog } from "../observability/audit.js";
import { maskIp, maskPhone } from "../utils/mask.js";
import { isValidMetaSignature } from "../whatsapp/signature.js";
import { handleInbound } from "../flows/handleInbound.js";
import { resolveTenant } from "../tenants/resolveTenant.js";

const router = express.Router();

async function isDuplicateWebhookMessage(tenantId, messageId) {
  const safeTenantId = String(tenantId || "").trim();
  const safeMessageId = String(messageId || "").trim();

  if (!safeTenantId || !safeMessageId) {
    return false;
  }

  const key = `wa:msg:${safeTenantId}:${safeMessageId}`;
  const created = await redis.set(key, "1", { ex: 300, nx: true });
  return !created;
}

function normalizeInboundText(msg) {
  const textBody = String(msg?.text?.body || "").trim();
  const buttonReplyId = String(msg?.interactive?.button_reply?.id || "").trim();
  const listReplyId = String(msg?.interactive?.list_reply?.id || "").trim();

  const value = buttonReplyId || listReplyId || textBody;
  return value.length > 500 ? value.slice(0, 500) : value;
}

router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

router.post("/webhook", async (req, res) => {
  let traceId = null;

  try {
    if (!isValidMetaSignature(req)) {
      audit("WEBHOOK_INVALID_SIGNATURE", {
        tenantId: null,
        traceId: null,
        ipMasked: maskIp(req.ip),
        hasSignatureHeader: !!req.headers["x-hub-signature-256"],
      });
      return res.sendStatus(403);
    }

    // ACK rápido para a Meta
    res.sendStatus(200);

    const body = req.body;
    if (!body || body.object !== "whatsapp_business_account") {
      audit("WEBHOOK_IGNORED_NON_WABA", {
        tenantId: null,
        traceId: null,
        ipMasked: maskIp(req.ip),
        hasBody: !!body,
        objectType: body?.object || null,
      });
      return;
    }

    const entry = body?.entry?.[0];
    if (!entry || !Array.isArray(entry.changes) || entry.changes.length === 0) {
      audit("WEBHOOK_INVALID_SHAPE", {
        tenantId: null,
        traceId: null,
        ipMasked: maskIp(req.ip),
        hasBody: !!body,
        hasEntry: !!entry,
      });
      return;
    }

    const change = entry.changes[0];
    if (
      !change ||
      change.field !== "messages" ||
      !change.value ||
      typeof change.value !== "object"
    ) {
      audit("WEBHOOK_INVALID_CHANGE_SHAPE", {
        tenantId: null,
        traceId: null,
        ipMasked: maskIp(req.ip),
        hasChange: !!change,
        field: change?.field || null,
      });
      return;
    }

    const value = change.value;
    const msg = value?.messages?.[0];

    // Pode ser status update ou outro evento sem mensagem inbound
    if (!msg) {
      audit("WEBHOOK_IGNORED_WITHOUT_MESSAGE", {
        tenantId: null,
        traceId: null,
        ipMasked: maskIp(req.ip),
        hasStatuses: Array.isArray(value?.statuses) && value.statuses.length > 0,
      });
      return;
    }

    traceId = crypto.randomUUID();

    const from = String(msg?.from || "").trim();
    const messageId = String(msg?.id || "").trim();
    const phoneNumberId = String(value?.metadata?.phone_number_id || "").trim();

    if (!from) {
      audit("WEBHOOK_IGNORED_MISSING_FROM", {
        tenantId: null,
        traceId,
        phoneNumberIdPresent: !!phoneNumberId,
        messageIdPresent: !!messageId,
      });
      return;
    }

    const tenantResolved = resolveTenant(phoneNumberId);

    if (!tenantResolved.ok) {
      audit("WEBHOOK_TENANT_NOT_RESOLVED", {
        tenantId: tenantResolved.tenantId || null,
        traceId,
        phoneMasked: maskPhone(from),
        phoneNumberIdPresent: !!phoneNumberId,
        phoneNumberId: phoneNumberId || null,
        reason: tenantResolved.reason,
        blockedBeforeFlow: true,
      });
      return;
    }

    const { tenantId, tenantConfig } = tenantResolved;

    if (await isDuplicateWebhookMessage(tenantId, messageId)) {
      audit("WEBHOOK_DUPLICATE_IGNORED", {
        tenantId,
        traceId,
        phoneMasked: maskPhone(from),
        messageIdPresent: !!messageId,
      });
      return;
    }

    const currentState = (await getState(tenantId, from)) || "(none)";
    const text = normalizeInboundText(msg);

    if (!text) {
      audit("WEBHOOK_IGNORED_EMPTY_MESSAGE", {
        tenantId,
        traceId,
        phoneMasked: maskPhone(from),
        state: currentState,
        hasInteractiveButtonReply: !!msg?.interactive?.button_reply?.id,
        hasInteractiveListReply: !!msg?.interactive?.list_reply?.id,
        hasTextBody: !!msg?.text?.body,
      });
      return;
    }

    const context = {
      tenantId,
      tenantConfig,
      traceId,
      phoneNumberId,
      LGPD_TEXT_VERSION,
      LGPD_TEXT_HASH,
    };

    audit("WEBHOOK_INBOUND", {
      tenantId,
      traceId,
      phoneMasked: maskPhone(from),
      state: currentState,
      messageHidden: true,
      hasInteractiveReply:
        !!msg?.interactive?.button_reply?.id || !!msg?.interactive?.list_reply?.id,
      hasTextBody: !!msg?.text?.body,
      phoneNumberIdPresent: !!phoneNumberId,
      messageIdPresent: !!messageId,
    });

    await handleInbound({
      context,
      phone: from,
      text,
      phoneNumberIdFallback: phoneNumberId,
    });
  } catch (err) {
    errLog("WEBHOOK_POST_ERROR", {
      tenantId: null,
      traceId,
      error: String(err?.message || err),
      stackPreview: err?.stack ? String(err.stack).slice(0, 500) : null,
    });
  }
});

export default router;
