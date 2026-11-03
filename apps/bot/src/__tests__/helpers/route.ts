import express, { type Router } from "express";
import type { AddressInfo } from "net";
import type { AdminCheck } from "../../middleware/auth";

export interface RouteResult {
  status: number;
  body: unknown;
}

interface CallOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  adminCheck?: AdminCheck;
  locals?: Record<string, unknown>;
}

/**
 * Monte le router sur une app Express éphémère (port aléatoire), comme en production derrière requireGuildAdmin,
 * puis exécute une vraie requête HTTP : on teste le comportement observable (statut + JSON).
 */
export async function callRoute(router: Router, opts: CallOptions): Promise<RouteResult> {
  const app = express();
  app.use(express.json());
  Object.assign(app.locals, opts.locals ?? {});
  app.use((req, _res, next) => {
    if (opts.adminCheck) req.adminCheck = opts.adminCheck;
    next();
  });
  app.use(router);

  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${opts.path}`, {
      method: opts.method,
      headers: { "Content-Type": "application/json" },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  } finally {
    server.close();
  }
}
