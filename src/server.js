import { PORT } from "./config/env.js";
import { opLog } from "./observability/audit.js";
import { createApp } from "./app.js";

const app = createApp();

app.listen(PORT, () => opLog("SERVER_LISTENING", { port: PORT }));
