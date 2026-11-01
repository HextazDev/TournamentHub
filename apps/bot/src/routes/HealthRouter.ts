import { Router } from "express";

export function createHealthRouter(isReady: () => boolean, databaseReady: () => Promise<boolean>) {
  const router = Router();
  router.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", botConnected: isReady() });
  });
  router.get("/ready", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const ready = isReady() && await databaseReady();
      res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "unavailable" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  return router;
}
