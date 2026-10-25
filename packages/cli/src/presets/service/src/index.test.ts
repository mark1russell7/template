import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { embeddedProcess, lint, localDev } from "@mark1russell7/service";
import type { Rule, Scenario } from "@mark1russell7/service";
import { describe, expect, it } from "vitest";
import { PROFILES, declare } from "./index.ts";

const s = (value: number) => ({ value, unit: "s" });

// The caller of lint() gives the rules of the ordering law, as data. These are the drain rules O10 and O16, as @mark1russell7/kind gives them.
const O10: Rule = {
  id: "O10",
  rule: "the preStop sleep plus the shutdown of the process fits in the grace period",
  expr: {
    lhs: {
      terms: [
        { knob: "prestop_sleep", coef: 1, at: "pod" },
        { knob: "process_drain_time", coef: 1, at: "process" },
      ],
    },
    op: "<=",
    rhs: { terms: [{ knob: "termination_grace", coef: 1, at: "pod" }] },
  },
};
const O16: Rule = {
  id: "O16",
  rule: "the cooperative window is shorter than the drain, which is shorter than the grace less the preStop sleep",
  expr: {
    lhs: { terms: [{ knob: "cooperative_window", coef: 1, at: "process" }] },
    op: "<",
    rhs: { terms: [{ knob: "process_drain_time", coef: 1, at: "process" }] },
  },
  expr_more: [
    {
      lhs: { terms: [{ knob: "process_drain_time", coef: 1, at: "process" }] },
      op: "<",
      rhs: {
        terms: [
          { knob: "termination_grace", coef: 1, at: "pod" },
          { knob: "prestop_sleep", coef: -1, at: "pod" },
        ],
      },
    },
  ],
};

// A pod with the default grace of Kubernetes (30 s) and no preStop hook
const POD: Scenario = {
  platform: { "termination_grace@pod": s(30), "prestop_sleep@pod": s(0) },
  probes: { readiness: s(30), liveness: s(30) },
};

/** This function gives a free TCP port of the loopback interface. */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

describe("the declaration of the service", () => {
  for (const [name, profile] of Object.entries(PROFILES)) {
    it(`passes describe() and lint() with the profile ${name}`, () => {
      // describe() throws when the declaration lacks a policy, the startup budget, the phases or the effect of a second signal
      const description = declare({ port: 0, probePort: 0, profile }).describe();
      expect(description.transports.map((transport) => [transport.kind, transport.name])).toEqual([["server", "http"]]);
      // each rule holds, and no field of the declaration is missing (a "depends" finding of the rule "declaration")
      const findings = lint(description, POD, [O10, O16]);
      expect(findings.map((finding) => [finding.rule, finding.verdict])).toEqual([
        ["O10", "holds"],
        ["O16", "holds"],
      ]);
    });
  }
});

describe("the lifecycle of the service", () => {
  it("answers a route and the probes, and exits 0 after the shutdown", async () => {
    const port = await freePort();
    const probePort = await freePort();
    // embeddedProcess() adds no signal handler and does not end the process of the test
    const life = await declare({ port, probePort, profile: localDev }).run({ process: embeddedProcess() });
    try {
      const hello = await fetch(`http://127.0.0.1:${port}/hello`);
      expect(hello.status).toBe(200);
      expect(await hello.json()).toEqual({ hello: "world" });
      expect((await fetch(`http://127.0.0.1:${port}/nothing`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${probePort}/readiness`)).status).toBe(200);
    } finally {
      await life.shutdown("the test ended");
    }
    expect(await life.done).toBe(0);
    expect(life.errors).toEqual([]);
  });
});
