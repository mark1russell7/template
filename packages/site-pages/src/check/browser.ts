/**
 * A small client of the Chrome DevTools protocol for the `check` command. It starts a Chromium
 * browser (Chrome, Edge or the Chromium of Playwright) in headless mode and drives one page. It
 * uses only Node.js, so the check needs no package install.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/** The paths that `findBrowser` examines after the option and the Playwright folder. */
function systemBrowsers(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === "win32") {
    const roots = [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env["LOCALAPPDATA"]].filter((root): root is string => !!root);
    return roots.flatMap((root) => [join(root, "Google/Chrome/Application/chrome.exe"), join(root, "Microsoft/Edge/Application/msedge.exe")]);
  }
  if (platform === "darwin") {
    return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];
  }
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];
  const dirs = (env["PATH"] ?? "").split(delimiter).filter(Boolean);
  return names.flatMap((name) => dirs.map((dir) => join(dir, name)));
}

/** The Chromium of the newest `chromium-<n>` folder of Playwright, or undefined. */
function playwrightChromium(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | undefined {
  const root =
    env["PLAYWRIGHT_BROWSERS_PATH"] ||
    (platform === "win32" ? join(env["LOCALAPPDATA"] ?? homedir(), "ms-playwright") : platform === "darwin" ? join(homedir(), "Library/Caches/ms-playwright") : join(homedir(), ".cache/ms-playwright"));
  if (!existsSync(root)) return undefined;
  const builds = readdirSync(root)
    .map((name) => /^chromium-(\d+)$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const [folder] of builds) {
    for (const sub of readdirSync(join(root, folder))) {
      const candidates =
        platform === "win32"
          ? [join(root, folder, sub, "chrome.exe")]
          : platform === "darwin"
            ? [join(root, folder, sub, "Chromium.app/Contents/MacOS/Chromium"), join(root, folder, sub, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")]
            : [join(root, folder, sub, "chrome")];
      const found = candidates.find((file) => existsSync(file));
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * This function finds a Chromium browser. It examines the given path, then `$SITE_CHECK_BROWSER`,
 * then the newest Chromium of Playwright, then a Chrome or an Edge of the system.
 *
 * @returns the path of the executable, or undefined when there is none
 */
export function findBrowser(given?: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const named = given || env["SITE_CHECK_BROWSER"];
  if (named) return named;
  return playwrightChromium(platform, env) ?? systemBrowsers(platform, env).find((file) => existsSync(file));
}

/** A message of the DevTools protocol. */
interface Message {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
}

/** An event handler of a page. */
type Listener = (params: Record<string, unknown>) => void;

/** The reply of `Runtime.evaluate` and `Runtime.callFunctionOn` with `returnByValue`. */
interface Reply {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

/** One page of a started browser. */
export interface Page {
  /** This function sends a command of the protocol and returns its result. */
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** This function calls the listener on each event of the method. */
  on(method: string, listener: Listener): void;
  /** This function calls the listener on the next event of the method, or rejects after `ms`. */
  once(method: string, ms: number): Promise<Record<string, unknown>>;
  /** This function evaluates the expression in the page, and waits for a promise. */
  evaluate<T>(expression: string): Promise<T>;
  /**
   * This function calls the function `source` in the page with the values `args`, and waits for a promise. The values go
   * to the page as the arguments of the call (`Runtime.callFunctionOn`), not as text of the code. Thus a value from a URL
   * or from a page cannot change the code.
   */
  call<T>(source: string, ...args: readonly CallValue[]): Promise<T>;
}

/** A value that {@link Page.call} gives to a function in the page. It goes to the page as JSON. */
export type CallValue = string | number | boolean | null | readonly CallValue[] | { readonly [key: string]: CallValue };

/** A started browser. */
export interface Browser {
  page: Page;
  /** This function stops the browser and removes its profile. */
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * This function starts the browser in headless mode with a new profile, and connects to its page.
 * The browser picks a free port, so two checks can run at the same time.
 *
 * @throws Error when the browser does not start in `timeoutMs`
 */
export async function launch(executable: string, timeoutMs = 30_000): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), "site-check-"));
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--hide-scrollbars",
    "--mute-audio",
    // The sandbox of Chromium needs user namespaces, which Ubuntu 24.04 refuses to a browser that the
    // system did not install. Playwright also starts Chromium with no sandbox.
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    "about:blank",
  ];
  const child: ChildProcess = spawn(executable, args, { stdio: "ignore" });
  let exited: string | undefined;
  child.once("exit", (code, signal) => (exited = `the browser stopped (code ${code}, signal ${signal})`));
  child.once("error", (error) => (exited = `the browser did not start: ${error.message}`));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(5000)]);
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  try {
    const portFile = join(profile, "DevToolsActivePort");
    const end = Date.now() + timeoutMs;
    let port = "";
    while (port === "") {
      if (exited !== undefined) throw new Error(`${executable}: ${exited}`);
      if (Date.now() > end) throw new Error(`${executable}: no DevTools port after ${timeoutMs} ms`);
      if (existsSync(portFile)) port = readFileSync(portFile, "utf8").split("\n")[0]?.trim() ?? "";
      if (port === "") await sleep(100);
    }
    let target: { type: string; webSocketDebuggerUrl: string } | undefined;
    while (target === undefined) {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      target = list.find((entry) => entry.type === "page");
      if (target === undefined) {
        if (Date.now() > end) throw new Error(`${executable}: no page target after ${timeoutMs} ms`);
        await sleep(100);
      }
    }
    const page = await connect(target.webSocketDebuggerUrl);
    return {
      page: page.page,
      close: async () => {
        page.close();
        await stop();
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function connect(url: string): Promise<{ page: Page; close: () => void }> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error(`no connection to ${url}`)), { once: true });
  });
  let sequence = 0;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  const listeners = new Map<string, Listener[]>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Message;
    if (message.id !== undefined) {
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) call?.reject(new Error(message.error.message));
      else call?.resolve(message.result ?? {});
    } else if (message.method) {
      for (const listener of listeners.get(message.method) ?? []) listener(message.params ?? {});
    }
  });
  socket.addEventListener("close", () => {
    for (const call of pending.values()) call.reject(new Error("the browser closed the connection"));
    pending.clear();
  });
  const page: Page = {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      }),
    on: (method, listener) => listeners.set(method, [...(listeners.get(method) ?? []), listener]),
    once: (method, ms) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          remove();
          reject(new Error(`no ${method} after ${ms} ms`));
        }, ms);
        const listener: Listener = (params) => {
          clearTimeout(timer);
          remove();
          resolve(params);
        };
        const remove = () => listeners.set(method, (listeners.get(method) ?? []).filter((entry) => entry !== listener));
        page.on(method, listener);
      }),
    evaluate: async <T>(expression: string): Promise<T> => {
      const reply = (await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as Reply;
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? "the expression failed");
      return reply.result?.value as T;
    },
    call: async <T>(source: string, ...args: readonly CallValue[]): Promise<T> => {
      // The global object of the page is the target of the call. A new page after a navigation has a new one.
      const target = (await page.send("Runtime.evaluate", { expression: "globalThis" })) as { result?: { objectId?: string } };
      const reply = (await page.send("Runtime.callFunctionOn", {
        functionDeclaration: source,
        objectId: target.result?.objectId,
        arguments: args.map((value) => ({ value })),
        awaitPromise: true,
        returnByValue: true,
      })) as Reply;
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? "the function failed");
      return reply.result?.value as T;
    },
  };
  return { page, close: () => socket.close() };
}
