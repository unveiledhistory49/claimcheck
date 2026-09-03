import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { createApp } from "./app.js";

const cfg = loadConfig();
const db = new Db(cfg.databaseUrl);
db.migrate();
const app = createApp(db, cfg, cfg.pepper);
app.listen(cfg.port, () => {
  console.log(`claimcheck listening on :${String(cfg.port)}`);
});
