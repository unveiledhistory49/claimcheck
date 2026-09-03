#!/usr/bin/env node
/** claimcheck CLI: provision-org, create-adjuster, serve, seed-demo, report. */
import { createHash, randomBytes } from "node:crypto";
import { loadConfig } from "./config.js";
import { Db, nowMs } from "./db.js";
import { createPolicy } from "./store/policies.js";
import { addItem, addWatch, createClaim, getClaim, listDecisions, listFraudFlags, listItems, claimTotal } from "./store/claims.js";
import { createAdjuster } from "./store/users.js";
import { runPipeline } from "./engine/workflow.js";
import { parseAmountToMinor } from "./money.js";

function flag(argv: string[], name: string, fallback = ""): string {
  const i = argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= argv.length) return fallback;
  const v = argv[i + 1];
  return v ?? fallback;
}

function provisionOrg(db: Db, pepper: string, name: string): void {
  if (name.trim() === "") throw new Error("--name is required");
  const raw = `cc_live_${randomBytes(16).toString("hex")}`;
  const hash = createHash("sha256").update(`${pepper}::${raw}`).digest("hex");
  const id = crypto.randomUUID().replace(/-/g, "");
  try {
    db.raw
      .prepare(`INSERT INTO orgs (id, name, api_key_hash, key_prefix, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, name.trim(), hash, raw.slice(-8), nowMs());
  } catch (err) {
    throw new Error(`provision failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(JSON.stringify({ org_id: id, name: name.trim(), api_key: raw }));
}

function createAdjusterCmd(db: Db, argv: string[]): void {
  const orgId = flag(argv, "org-id");
  const roleFlag = flag(argv, "role", "adjuster");
  if (roleFlag !== "adjuster" && roleFlag !== "supervisor") throw new Error("--role must be adjuster|supervisor");
  const a = createAdjuster(
    db,
    orgId,
    { email: flag(argv, "email"), name: flag(argv, "name"), password: flag(argv, "password"), role: roleFlag },
    nowMs(),
  );
  console.log(JSON.stringify({ id: a.id, email: a.email, role: a.role }));
}

function seedDemo(db: Db, orgId: string): void {
  const now = nowMs();
  const day = 86_400_000;
  const auto = createPolicy(db, orgId, {
    policyNumber: "AUTO-001", holderName: "Ada Driver", product: "auto",
    coverageLimitMinor: parseAmountToMinor("50000"), deductibleMinor: parseAmountToMinor("1000"),
    effectiveFromMs: now - 365 * day, effectiveUntilMs: now + 365 * day,
  }, now);
  const prop = createPolicy(db, orgId, {
    policyNumber: "PROP-001", holderName: "Bo House", product: "property",
    coverageLimitMinor: parseAmountToMinor("250000"), deductibleMinor: parseAmountToMinor("2500"),
    effectiveFromMs: now - 365 * day, effectiveUntilMs: now + 365 * day,
  }, now);
  addWatch(db, orgId, "name", "fraud fraser", "known fraud ring", now);
  const mk = (policyId: string, name: string, incidentAgoDays: number, items: { category: string; amount: string }[]): string => {
    const c = createClaim(db, {
      orgId, policyId, claimantName: name, claimantEmail: "",
      incidentMs: now - incidentAgoDays * day, reportedMs: now - incidentAgoDays * day + 3_600_000,
      description: "seed demo",
    }, now);
    for (const it of items) {
      addItem(db, c.id, { category: it.category, description: "seed", amountMinor: parseAmountToMinor(it.amount) }, now);
    }
    const r = runPipeline(db, orgId, c.id, "seed");
    console.log(JSON.stringify({ claim: c.claimNumber, status: r.claim.status, decision: r.decision?.outcome ?? null, score: r.score }));
    return c.id;
  };
  mk(auto.id, "Ada Driver", 10, [{ category: "repair", amount: "3200.50" }]);
  mk(prop.id, "Bo House", 5, [{ category: "property", amount: "12000.00" }]);
  mk(auto.id, "Fraud Fraser", 2, [{ category: "repair", amount: "45000.00" }]);
}

function report(db: Db, orgId: string, claimId: string): void {
  const claim = getClaim(db, orgId, claimId);
  console.log(JSON.stringify({
    claim,
    items: listItems(db, claimId),
    totalMinor: claimTotal(db, claimId),
    flags: listFraudFlags(db, claimId),
    decisions: listDecisions(db, claimId),
  }, null, 2));
}

export function main(argv: string[]): void {
  const cfg = loadConfig();
  const dbPath = flag(argv, "db", cfg.databaseUrl);
  const db = new Db(dbPath);
  db.migrate();
  const cmd = argv[2] ?? "";
  if (cmd === "provision-org") provisionOrg(db, cfg.pepper, flag(argv, "name"));
  else if (cmd === "create-adjuster") createAdjusterCmd(db, argv);
  else if (cmd === "serve") {
    const port = Number(flag(argv, "port", String(cfg.port)));
    import("./app.js").then(
      ({ createApp }) => {
        createApp(db, cfg, cfg.pepper).listen(port, () => {
          console.log(`claimcheck listening on :${String(port)}`);
        });
      },
      (err: unknown) => {
        console.error(err);
        process.exitCode = 1;
      },
    );
  } else if (cmd === "seed-demo") seedDemo(db, flag(argv, "org-id"));
  else if (cmd === "report") report(db, flag(argv, "org-id"), flag(argv, "claim-id"));
  else {
    console.error("usage: claimcheck <provision-org|create-adjuster|serve|seed-demo|report> [flags]");
    process.exitCode = 1;
  }
  if (cmd !== "serve") db.close();
}

const isMain = process.argv[1]?.endsWith("/cli.js") === true || process.argv[1]?.endsWith("\\cli.js") === true;
if (isMain) main(process.argv);
