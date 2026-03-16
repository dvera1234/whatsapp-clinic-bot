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
  const id = String(messageId || "").trim();
  if (!safeTenantId || !id) return false;

  const key = `wa:msg:${safeTenantId}:${id}`;
  const created = await redis.set(key, "1", { ex: 300, nx: true });
  return !created;
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
  try {
    if (!isValidMetaSignature(req)) {
      audit("WEBHOOK_INVALID_SIGNATURE", {
        tenantId: null,
        ipMasked: maskIp(req.ip),
        hasSignatureHeader: !!req.headers["x-hub-signature-256"],
      });
      return res.sendStatus(403);
    }

    res.sendStatus(200);

    const body = req.body;
    if (!body || body.object !== "whatsapp_business_account") return;

    const entry = body.entry?.[0];
    if (!entry || !Array.isArray(entry.changes) || entry.changes.length === 0) {
      audit("WEBHOOK_INVALID_SHAPE", {
        tenantId: null,
        ipMasked: maskIp(req.ip),
        hasBody: !!body,
      });
      return;
    }

    const change = entry.changes[0];
    if (!change || change.field !== "messages" || !change.value || typeof change.value !== "object") {
      audit("WEBHOOK_INVALID_CHANGE_SHAPE", {
        tenantId: null,
        ipMasked: maskIp(req.ip),
      });
      return;
    }

    const value = change.value;
    const msg = value?.messages?.[0];
    if (!msg) return;

    const traceId = crypto.randomUUID();
    const from = String(msg.from || "").trim();
    const messageId = msg.id || null;
    const phoneNumberId = String(value?.metadata?.phone_number_id || "").trim();

    const tenantResolved = resolveTenant(phoneNumberId);
    if (!tenantResolved) {
      audit("WEBHOOK_TENANT_NOT_RESOLVED", {
        tenantId: null,
        traceId,
        phoneMasked: maskPhone(from),
        phoneNumberIdPresent: !!phoneNumberId,
      });
      return;
    }

    const { tenantId, tenantConfig } = tenantResolved;

    const context = {
      tenantId,
      tenantConfig,
      traceId,
      phoneNumberId,
      LGPD_TEXT_VERSION,
      LGPD_TEXT_HASH,
    };

    const currentState = (await getState(tenantId, from)) || "(none)";

    if (await isDuplicateWebhookMessage(tenantId, messageId)) {
      audit("WEBHOOK_DUPLICATE_IGNORED", {
        tenantId,
        traceId,
        phoneMasked: maskPhone(from),
      });
      return;
    }

    let text = (msg.text?.body || msg.interactive?.button_reply?.id || "").trim();
    if (text.length > 500) {
      text = text.slice(0, 500);
    }

    if (!text) {
      audit("WEBHOOK_IGNORED_EMPTY_MESSAGE", {
        tenantId,
        traceId,
        phoneMasked: maskPhone(from),
      });
      return;
    }

    audit("WEBHOOK_INBOUND", {
      tenantId,
      traceId,
      phoneMasked: maskPhone(from),
      state: currentState,
      messageHidden: true,
      hasInteractiveReply: !!msg.interactive?.button_reply?.id,
      hasTextBody: !!msg.text?.body,
      phoneNumberIdPresent: !!phoneNumberId,
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
      error: String(err?.message || err),
      stackPreview: err?.stack ? String(err.stack).slice(0, 500) : null,
    });
  }
});

export default router;
