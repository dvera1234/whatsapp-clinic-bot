import express from "express";
import crypto from "crypto";

import { redis } from "../redis.js";
import { getState } from "../session/redisSession.js";
import { VERIFY_TOKEN } from "../config/env.js";
import { LGPD_TEXT_HASH, LGPD_TEXT_VERSION } from "../config/constants.js";
import { audit, errLog } from "../observability/audit.js";
import { maskIp, maskPhone } from "../utils/mask.js";
import { isValidMetaSignature } from "../whatsapp/signature.js";
import { handleInbound } from "../flows/handleInbound.js";
import { resolveTenant } from "../tenants/resolveTenant.js";

const router = express.Router();

const WEBHOOK_MESSAGE_DEDUP_TTL_SECONDS = 300;
const MAX_INBOUND_TEXT_LENGTH = 500;

function safeString(value) {
  return String(value ?? "").trim();
}

function buildTraceId() {
  return crypto.randomUUID();
}

async function isDuplicateWebhookMessage(tenantId, messageId) {
  const safeTenantId = safeString(tenantId);
  const safeMessageId = safeString(messageId);

  if (!safeTenantId || !safeMessageId) {
    return false;
  }

  const key = `wa:msg:${safeTenantId}:${safeMessageId}`;
  const created = await redis.set(key, "1", {
    ex: WEBHOOK_MESSAGE_DEDUP_TTL_SECONDS,
    nx: true,
  });

  return !created;
}

function normalizeInboundText(message) {
  const textBody = safeString(message?.text?.body);
  const buttonReplyId = safeString(message?.interactive?.button_reply?.id);
  const listReplyId = safeString(message?.interactive?.list_reply?.id);

  const inboundText = buttonReplyId || listReplyId || textBody;

  return inboundText.length > MAX_INBOUND_TEXT_LENGTH
    ? inboundText.slice(0, MAX_INBOUND_TEXT_LENGTH)
    : inboundText;
}

function extractWebhookPayload(req) {
  const body = req?.body;
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];

  return { body, entry, change, value, message };
}

function buildInboundContext({ tenantId, runtime, traceId, phoneNumberId }) {
  return {
    tenantId,
    runtime,
    traceId,
    phoneNumberId,
    LGPD_TEXT_VERSION,
    LGPD_TEXT_HASH,
  };
}

function auditIgnoredWebhook(event, payload = {}) {
  audit(event, {
    tenantId: null,
    traceId: null,
    ...payload,
  });
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
  let tenantId = null;

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

    res.sendStatus(200);

    const { body, entry, change, value, message } = extractWebhookPayload(req);

    if (!body || body.object !== "whatsapp_business_account") {
      auditIgnoredWebhook("WEBHOOK_IGNORED_NON_WABA", {
        ipMasked: maskIp(req.ip),
        hasBody: !!body,
        objectType: body?.object || null,
      });
      return;
    }

    if (!entry || !Array.isArray(entry.changes) || entry.changes.length === 0) {
      auditIgnoredWebhook("WEBHOOK_INVALID_SHAPE", {
        ipMasked: maskIp(req.ip),
        hasBody: !!body,
        hasEntry: !!entry,
      });
      return;
    }

    if (
      !change ||
      change.field !== "messages" ||
      !value ||
      typeof value !== "object"
    ) {
      auditIgnoredWebhook("WEBHOOK_INVALID_CHANGE_SHAPE", {
        ipMasked: maskIp(req.ip),
        hasChange: !!change,
        field: change?.field || null,
      });
      return;
    }

    if (!message) {
      auditIgnoredWebhook("WEBHOOK_IGNORED_WITHOUT_MESSAGE", {
        ipMasked: maskIp(req.ip),
        hasStatuses: Array.isArray(value?.statuses) && value.statuses.length > 0,
      });
      return;
    }

    traceId = buildTraceId();

    const phone = safeString(message?.from);
    const messageId = safeString(message?.id);
    const phoneNumberId = safeString(value?.metadata?.phone_number_id);

    if (!phone) {
      audit("WEBHOOK_IGNORED_MISSING_FROM", {
        tenantId: null,
        traceId,
        phoneNumberIdPresent: !!phoneNumberId,
        messageIdPresent: !!messageId,
      });
      return;
    }

    const tenantResolved = await resolveTenant(phoneNumberId);

    if (!tenantResolved?.ok) {
      audit("WEBHOOK_TENANT_NOT_RESOLVED", {
        tenantId: tenantResolved?.tenantId || null,
        traceId,
        phoneMasked: maskPhone(phone),
        phoneNumberIdPresent: !!phoneNumberId,
        phoneNumberId: phoneNumberId || null,
        reason: tenantResolved?.reason || "UNKNOWN",
        missingFields: tenantResolved?.missing || [],
        blockedBeforeFlow: true,
      });
      return;
    }

    tenantId = tenantResolved.tenantId;
    const runtime = tenantResolved.runtime;

    if (await isDuplicateWebhookMessage(tenantId, messageId)) {
      audit("WEBHOOK_DUPLICATE_IGNORED", {
        tenantId,
        traceId,
        phoneMasked: maskPhone(phone),
        messageIdPresent: !!messageId,
      });
      return;
    }

    const currentState = (await getState(tenantId, phone)) || "(none)";
    const text = normalizeInboundText(message);

    if (!text) {
      audit("WEBHOOK_IGNORED_EMPTY_MESSAGE", {
        tenantId,
        traceId,
        phoneMasked: maskPhone(phone),
        state: currentState,
        hasInteractiveButtonReply: !!message?.interactive?.button_reply?.id,
        hasInteractiveListReply: !!message?.interactive?.list_reply?.id,
        hasTextBody: !!message?.text?.body,
      });
      return;
    }

    const context = buildInboundContext({
      tenantId,
      runtime,
      traceId,
      phoneNumberId,
    });

    audit("WEBHOOK_INBOUND", {
      tenantId,
      traceId,
      phoneMasked: maskPhone(phone),
      state: currentState,
      messageHidden: true,
      hasInteractiveReply:
        !!message?.interactive?.button_reply?.id ||
        !!message?.interactive?.list_reply?.id,
      hasTextBody: !!message?.text?.body,
      phoneNumberIdPresent: !!phoneNumberId,
      messageIdPresent: !!messageId,
    });

    await handleInbound({
      context,
      phone,
      text,
      message,
      phoneNumberId,
    });
  } catch (err) {
    errLog("WEBHOOK_POST_ERROR", {
      tenantId,
      traceId,
      error: String(err?.message || err),
      stackPreview: err?.stack ? String(err.stack).slice(0, 500) : null,
    });
  }
});

export default router;
