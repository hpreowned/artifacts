// Tiny health endpoint for the worker (it exposes no other API). `deploy/platform/scanner-worker.yaml`
// probes `GET /healthz` on `HEALTH_PORT` (default 8081) for both readiness and liveness.
import { createServer, type Server } from "node:http";

export type QueueKind = "memory" | "servicebus";

/** Flips to down once the queue consumer stops (graceful shutdown, or a startup failure the caller reports). */
export class HealthState {
  private up = true;
  constructor(readonly queueKind: QueueKind) {}

  get ok(): boolean {
    return this.up;
  }
  markDown(): void {
    this.up = false;
  }
}

export function startHealthServer(port: number, state: HealthState): Server {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method !== "GET" || path !== "/healthz") {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      return;
    }
    const body = JSON.stringify({ ok: state.ok, queue: state.queueKind });
    res.writeHead(state.ok ? 200 : 503, { "content-type": "application/json" }).end(body);
  });
  server.listen(port);
  return server;
}
