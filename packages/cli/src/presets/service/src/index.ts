import { kubernetes, localDev, service } from "@mark1russell7/service";
import type { Profile, ServiceBuilder } from "@mark1russell7/service";
import { probeServer } from "@mark1russell7/service/http";
import { attachApi } from "./api.ts";

export { attachApi, type ApiOptions } from "./api.ts";

const s = (value: number) => ({ value, unit: "s" });

/**
 * These are the profiles of the shutdown, by name. `local` is for the computer of a developer.
 * `pod` is for a pod of Kubernetes with a grace of 30 s and no preStop hook. Make `grace` equal to
 * the `terminationGracePeriodSeconds` of the pod.
 */
export const PROFILES: Readonly<Record<string, Profile>> = {
  local: localDev,
  pod: kubernetes({ grace: s(30), preStop: s(0) }),
};

/** These are the options of the service. */
export interface Options {
  /** This number is the port of the API. */
  readonly port: number;
  /** This number is the port of the probes: `/startup`, `/readiness`, `/liveness` and `/report`. */
  readonly probePort: number;
  /** This profile gives the phases of the shutdown and the effect of a second signal. */
  readonly profile: Profile;
}

/**
 * This function declares the one service of the process. It starts nothing. `describe()` gives the
 * declaration as data, and `lint()` examines it. Only the entry (`main.ts`) uses `run()`.
 */
export const declare = (options: Options): ServiceBuilder =>
  attachApi(service("{{name}}"), { port: options.port })
    // The probes have a port of their own. Thus they answer through the whole shutdown.
    .healthServer(probeServer({ port: options.probePort, server_retry_after: s(1) }))
    // The policies apply to the checks of the service. Add a check with `check(check, run)`.
    .readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 })
    .liveness({ type: "window", failAfter: s(45) })
    .startup(s(30))
    .profile(options.profile);
