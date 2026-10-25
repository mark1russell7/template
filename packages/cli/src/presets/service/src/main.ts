/**
 * This file is the entry of the process, and the only file that uses `run()`. The lifecycle owns the
 * signals of the process. After SIGTERM or Ctrl-C, the service stops in its phases, and the process
 * exits with 0 or 1.
 *
 * The environment gives `PORT` (8080), `PROBE_PORT` (9090) and `SERVICE_PROFILE` (`local`). The
 * value in parentheses is the value without the variable.
 */
import { PROFILES, declare } from "./index.ts";

/** This function gives a port from the environment, or the fallback when the variable is not set. */
const port = (name: string, fallback: number): number => {
  const text = process.env[name];
  const value = text === undefined ? fallback : Number(text);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`${name} is not a port: ${text}`);
  return value;
};

const name = process.env["SERVICE_PROFILE"] ?? "local";
const profile = PROFILES[name];
if (profile === undefined) throw new Error(`SERVICE_PROFILE is "${name}". The profiles are: ${Object.keys(PROFILES).join(", ")}.`);

await declare({ port: port("PORT", 8080), probePort: port("PROBE_PORT", 9090), profile }).run();
