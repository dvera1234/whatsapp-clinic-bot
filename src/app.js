import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import webhookRouter from "./routes/webhook.js";
import healthRouter from "./routes/health.js";
import { errLog } from "./observability/audit.js";
import { maskIp } from "./utils/mask.js";
import { configureInactivityHandler } from "./session/redisSession.js";
import { sendText } from "./whatsapp/sender.js";

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "too many requests" },
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "too many webhook requests" },
});

const debugLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "too many debug requests" },
});

const app = express();

app.set("trust proxy", 1);
app.disable("x-powered-by");

configureInactivityHandler({ sendText });

app.use(globalLimiter);
app.use("/webhook", webhookLimiter);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

app.use(
  express.json({
    limit: "128kb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(
  express.urlencoded({
    extended: false,
    limit: "64kb",
  })
);

app.use(healthRouter);
app.use(webhookRouter);

app.use((err, req, res, _next) => {
  errLog("UNHANDLED_SERVER_ERROR", {
    route: req.originalUrl || req.url || null,
    method: req.method || null,
    ipMasked: maskIp(req.ip),
    error: String(err?.message || err),
    stackPreview: err?.stack ? String(err.stack).slice(0, 500) : null,
  });

  return res.sendStatus(500);
});

app.use((_req, res) => {
  return res.sendStatus(404);
});

export { debugLimiter };
export default app;
