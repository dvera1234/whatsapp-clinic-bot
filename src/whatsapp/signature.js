import crypto from "crypto";
import { APP_SECRET } from "../config/env.js";
import { safeEqual } from "../utils/crypto.js";

function isValidMetaSignature(req) {
  const signatureHeader = req.headers["x-hub-signature-256"];

  if (!signatureHeader || !req.rawBody) {
    return false;
  }

  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", APP_SECRET)
      .update(req.rawBody)
      .digest("hex");

  return safeEqual(String(signatureHeader), expected);
}

export { isValidMetaSignature };
