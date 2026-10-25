// THROWAWAY: a deliberate command injection and code injection, to prove that the CodeQL gate fails.
import { createServer } from "node:http";
import { exec } from "node:child_process";

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  exec("ls " + url.searchParams.get("dir"), (error, stdout) => res.end(stdout));
  eval(url.searchParams.get("code") ?? "");
}).listen(8080);
