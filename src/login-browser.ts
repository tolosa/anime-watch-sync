import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js";

type Commands = ProtocolMapping.Commands;
type Events = ProtocolMapping.Events;
const disconnected = () => new Error("The login browser connection closed. Run auth login again.");

/** Small CDP client. No page scripts, emulation, Runtime.enable, or automation framework. */
export class BrowserConnection {
  private readonly socket: WebSocket;
  private readonly events = new EventEmitter();
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private nextId = 0;
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      let message: {
        id?: number;
        result?: unknown;
        error?: unknown;
        method?: string;
        params?: unknown;
      };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        this.close();
        return;
      }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error)
          pending.reject(new Error("The login browser could not complete a debugging request."));
        else pending.resolve(message.result);
      } else if (message.method) {
        this.events.emit(message.method, message.params);
      }
    });
    const closed = () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(disconnected());
      }
      this.pending.clear();
      this.events.emit("closed");
    };
    socket.addEventListener("close", closed, { once: true });
    socket.addEventListener("error", closed, { once: true });
  }

  static async connect(url: string, signal: AbortSignal): Promise<BrowserConnection> {
    const socket = new WebSocket(url);
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          cleanup();
          reject(disconnected());
        };
        const opened = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          socket.removeEventListener("open", opened);
          socket.removeEventListener("error", abort);
          socket.removeEventListener("close", abort);
          signal.removeEventListener("abort", abort);
        };
        socket.addEventListener("open", opened, { once: true });
        socket.addEventListener("error", abort, { once: true });
        socket.addEventListener("close", abort, { once: true });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      return new BrowserConnection(socket);
    } catch (error) {
      socket.addEventListener("error", () => {}, { once: true });
      socket.close();
      throw error;
    }
  }

  send<K extends keyof Commands>(
    method: K,
    ...params: Commands[K]["paramsType"]
  ): Promise<Commands[K]["returnType"]> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(disconnected());
    const id = ++this.nextId;
    const pending = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      pending.reject(new Error("The login browser did not respond in time."));
    }, 10_000);
    this.pending.set(id, { ...pending, timer });
    this.socket.send(JSON.stringify({ id, method, params: params[0] ?? {} }));
    return pending.promise as Promise<Commands[K]["returnType"]>;
  }

  on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): void {
    this.events.on(event, listener);
  }
  onClose(listener: () => void): void {
    this.events.once("closed", listener);
  }
  close(): void {
    this.socket.close();
  }
}

export async function findBrowser(channel: "chrome" | "msedge"): Promise<string> {
  const override = process.env.CR_BROWSER_PATH?.trim();
  const names =
    channel === "chrome"
      ? ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
      : ["microsoft-edge", "microsoft-edge-stable"];
  const candidates = override
    ? [resolve(override)]
    : process.platform === "darwin"
      ? [
          channel === "chrome"
            ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            : "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
      : process.platform === "win32"
        ? [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
            .filter((path): path is string => !!path)
            .map((path) =>
              join(
                path,
                channel === "chrome"
                  ? "Google/Chrome/Application/chrome.exe"
                  : "Microsoft/Edge/Application/msedge.exe",
              ),
            )
        : (process.env.PATH ?? "")
            .split(delimiter)
            .filter(Boolean)
            .flatMap((path) => names.map((name) => join(path, name)));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Try next installation. */
    }
  }
  throw new Error(
    `Could not find ${channel === "chrome" ? "Google Chrome" : "Microsoft Edge"}. Install it or set CR_BROWSER_PATH to its executable.`,
  );
}

/** An ordinary, visible browser with a separate profile and loopback-only debugging. */
export function loginBrowserArguments(profile: string, port: number): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Expected a nonzero local debugging port.");
  return [
    `--user-data-dir=${profile}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
}

async function availablePort(): Promise<number> {
  await using server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not allocate a local browser port.");
  return address.port;
}

async function browserTarget(port: number, signal: AbortSignal): Promise<string> {
  while (!signal.aborted) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
      });
      const targets: unknown = await response.json();
      if (response.ok && Array.isArray(targets)) {
        const target = targets.find(
          (item) =>
            item?.type === "page" &&
            item.url === "about:blank" &&
            typeof item.webSocketDebuggerUrl === "string",
        );
        if (target) {
          const url = new URL(target.webSocketDebuggerUrl);
          if (
            url.protocol === "ws:" &&
            url.hostname === "127.0.0.1" &&
            url.port === String(port) &&
            !url.username &&
            !url.password &&
            url.pathname.startsWith("/devtools/page/")
          )
            return url.href;
        }
      }
    } catch {
      /* Browser may not have opened its debugging socket yet. */
    }
    await sleep(100, undefined, { signal }).catch(() => {});
  }
  throw new Error("The login browser did not start in time or was closed. Run auth login again.");
}

export interface LoginBrowser extends AsyncDisposable {
  connection: BrowserConnection;
}

export async function openLoginBrowser(options: {
  sessionPath: string;
  channel: "chrome" | "msedge";
  signal: AbortSignal;
}): Promise<LoginBrowser> {
  const executable = await findBrowser(options.channel);
  await mkdir(dirname(options.sessionPath), { recursive: true, mode: 0o700 });
  const profile = await mkdtemp(join(dirname(options.sessionPath), ".cr-login-"));
  await chmod(profile, 0o700);
  let processHandle: ChildProcess | undefined;
  let connection: BrowserConnection | undefined;
  let exited: Promise<unknown> = Promise.resolve();
  const stopped = new AbortController();
  const signal = AbortSignal.any([options.signal, stopped.signal, AbortSignal.timeout(30_000)]);
  const cleanup = async () => {
    if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
      processHandle.kill("SIGTERM");
      await Promise.race([exited, sleep(3000)]);
      if (processHandle.exitCode === null && processHandle.signalCode === null) {
        processHandle.kill("SIGKILL");
        await exited;
      }
    }
    connection?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };
  try {
    options.signal.throwIfAborted();
    const port = await availablePort();
    processHandle = spawn(executable, loginBrowserArguments(profile, port), { stdio: "ignore" });
    exited = new Promise<void>((resolve) => {
      processHandle!.once("error", () => {
        stopped.abort();
        resolve();
      });
      processHandle!.once("exit", () => {
        stopped.abort();
        resolve();
      });
    });
    connection = await BrowserConnection.connect(await browserTarget(port, signal), signal);
    return { connection, [Symbol.asyncDispose]: cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
