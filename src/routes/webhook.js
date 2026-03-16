import express from "express";
import crypto from "crypto";
import { getState, redis } from "../session/redisSession.js";
import { VERIFY_TOKEN } from "../config/env.js";
import { LGPD_TEXT_HASH, LGPD_TEXT_VERSION } from "../config/constants.js";
import { audit, errLog } from "../observability/audit.js";
import { maskIp, maskPhone } from "../utils/mask.js";
import { isValidMetaSignature } from "../whatsapp/signature.js";
import { handleInbound } from "../flows/handleInbound.js";

const router = express.Router();

async function isDuplicateWebhookMessage(messageId) {
  const id = String(messageId || "").trim();
  if (!id) return false;

  const key = `wa:msg:${id}`;
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
        ipMasked: maskIp(req.ip),
        hasBody: !!body,
      });
      return;
    }

    const change = entry.changes[0];
    if (!change || change.field !== "messages" || !change.value || typeof change.value !== "object") {
      audit("WEBHOOK_INVALID_CHANGE_SHAPE", {
        ipMasked: maskIp(req.ip),
      });
      return;
    }

    const value = change.value;
    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;
    const currentState = (await getState(from)) || "(none)";
    const traceId = crypto.randomUUID();
    const messageId = msg.id || null;

    if (await isDuplicateWebhookMessage(messageId)) {
      audit("WEBHOOK_DUPLICATE_IGNORED", {
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
        traceId,
        phoneMasked: maskPhone(from),
      });
      return;
    }

    const phoneNumberIdFallback = value?.metadata?.phone_number_id || "";

    audit("WEBHOOK_INBOUND", {
      traceId,
      phoneMasked: maskPhone(from),
      state: currentState,
      messageHidden: true,
      hasInteractiveReply: !!msg.interactive?.button_reply?.id,
      hasTextBody: !!msg.text?.body,
      phoneNumberIdPresent: !!phoneNumberIdFallback,
    });

    await handleInbound(from, text, phoneNumberIdFallback, {
      traceId,
      LGPD_TEXT_VERSION,
      LGPD_TEXT_HASH,
    });
  } catch (err) {
    errLog("WEBHOOK_POST_ERROR", {
      error: String(err?.message || err),
      stackPreview: err?.stack ? String(err.stack).slice(0, 500) : null,
    });
  }
});

export default router;
