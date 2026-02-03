import express from "express";

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// =======================
// Health check
// =======================
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

// =======================
// Webhook verification (GET)
// =======================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// =======================
// Webhook receiver (POST)
// =======================
app.post("/webhook", (req, res) => {
  console.log("=== WEBHOOK POST RECEBIDO ===");
  console.log(JSON.stringify(req.body, null, 2));
  console.log("================================");

  // responde rápido para a Meta
  res.sendStatus(200);
});

// =======================
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
