import app from "./app.js";
import { PORT } from "./config/env.js";
import { opLog } from "./observability/audit.js";

app.listen(PORT, () => {
  opLog("SERVER_LISTENING", { port: PORT });
});
