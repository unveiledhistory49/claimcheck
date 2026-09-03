import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import type { Db } from "./db.js";
import { loginAdjuster } from "./auth.js";
import { authMiddleware } from "./http.js";
import { errorMiddleware } from "./http.js";
import { str } from "./http.js";
import { adminRoutes } from "./routes/admin.js";
import { appealRoutes, claimRoutes } from "./routes/claims.js";
import { policyRoutes } from "./routes/policies.js";

export function createApp(db: Db, cfg: AppConfig, pepper: string): express.Express {
  const app = express();

  app.use((req: Request, res: Response, next: NextFunction) => {
    const rid: string = req.header("X-Request-ID") ?? randomUUID();
    res.setHeader("X-Request-ID", rid);
    next();
  });
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, version: "1.0.0", time: new Date().toISOString() });
  });

  // Public: session login must not sit behind API-key auth.
  app.post("/v1/login", (req: Request, res: Response, next: NextFunction) => {
    void (async (): Promise<void> => {
      const b = req.body as Record<string, unknown>;
      res.json(
        loginAdjuster(db, str(b, "orgId"), str(b, "email"), str(b, "password"), 12 * 3_600_000),
      );
    })().catch(next);
  });

  const authed = authMiddleware(db, pepper);
  app.use("/v1/policies", authed, policyRoutes(db, cfg));
  app.use("/v1/claims", authed, claimRoutes(db, cfg));
  app.use("/v1/appeals", authed, appealRoutes(db, cfg));
  app.use("/v1", authed, adminRoutes(db, cfg));

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });
  app.use(errorMiddleware);
  return app;
}
