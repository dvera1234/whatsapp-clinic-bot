import crypto from "crypto";
import { APP_SECRET } from "../config/env.js";
import { safeEqual } from "../utils/crypto.js";

function readString(value) {
  const v = String(value ?? "").trim();
  return v || "";
}

function isValidMetaSignature(req) {
  const signatureHeader = req.headers["x-hub-signature-256"];

  const secret = readString(APP_SECRET);

  if (!secret) {
    // erro estrutural — ambiente mal configurado
    return false;
  }

  if (!signatureHeader || !req.rawBody) {
    return false;
  }

  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", secret)
      .update(req.rawBody)
      .digest("hex");

  return safeEqual(String(signatureHeader), expected);
}

export { isValidMetaSignature };
