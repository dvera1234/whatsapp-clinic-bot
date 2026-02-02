import express from "express";

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// health check
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

// webhook verification (Meta -> GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// incoming messages (Meta -> POST)
app.post("/webhook", async (req, res) => {
  // sempre responde 200 rápido
  res.sendStatus(200);

  // por enquanto não faz nada aqui (vamos ligar o envio no próximo passo)
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
