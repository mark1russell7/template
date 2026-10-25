import { createServer } from "node:http";
import type { ServiceBuilder } from "@mark1russell7/service";
import { handle, httpTransport } from "@mark1russell7/service/http";

/** These are the options of the API of the service. */
export interface ApiOptions {
  /** This number is the port of the API. */
  readonly port: number;
}

const s = (value: number) => ({ value, unit: "s" });

/**
 * This function gives the API to the service of the entry: an HTTP server, its controller and its
 * routes. The API is a component. It does not start the server, and it does not use `run()`.
 */
export const attachApi = (svc: ServiceBuilder, options: ApiOptions): ServiceBuilder => {
  // The transport has no defaults: the idle close, the sweep of idle connections and the Retry-After of each 503.
  const http = httpTransport(
    createServer(),
    { server_idle_close: s(65), server_idle_sweep_interval: s(1), server_retry_after: s(1) },
    { listen: { port: options.port } },
  );
  // Each request of a route goes through the service. Thus the drain waits for it, and the shutdown can cut it.
  http.mount(handle("api", "GET /hello", () => ({ hello: "world" })));
  // Each route declares if a client can send it again.
  svc.controller("api").route("GET /hello", { idempotent: true });
  return svc.server("http", http.knobs, http);
};
