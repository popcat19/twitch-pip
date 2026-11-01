#!/usr/bin/env node
// Purpose: Toggle a pinned Twitch player and chat in an isolated Helium profile, switching to the highest-priority live channel at runtime
//
// One `serve` process owns the browser through --remote-debugging-pipe (no TCP port, so other
// local processes cannot drive the logged-in session). Hotkey invocations talk to it over a
// unix socket in $XDG_RUNTIME_DIR.

import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

const [configPath, cmd = "toggle"] = process.argv.slice(2);
if (!configPath) {
  console.error("usage: twitch-pip <config.json> [toggle|chat|login|status|quit|serve]");
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(configPath, "utf8"));
const LOGIN = /^[a-z0-9_]{1,25}$/;
for (const c of [...cfg.channels, cfg.fallback]) {
  if (!LOGIN.test(c)) throw new Error(`invalid twitch login: ${c}`);
}

if (!process.env.XDG_RUNTIME_DIR) throw new Error("XDG_RUNTIME_DIR is unset");
const SOCK = join(process.env.XDG_RUNTIME_DIR, "twitch-pip.sock");
const COMMANDS = new Set(["toggle", "chat", "login", "reset", "status", "quit"]);
const HIDDEN = "special:twitch-pip";

// Hyprland request socket; same wire format as hyprctl. Window management is skipped
// outside Hyprland or when the module disables it.
const HYPR = cfg.hyprland && process.env.HYPRLAND_INSTANCE_SIGNATURE
  ? join(process.env.XDG_RUNTIME_DIR, "hypr", process.env.HYPRLAND_INSTANCE_SIGNATURE, ".socket.sock")
  : null;

function hypr(request) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(HYPR);
    let out = "";
    conn.on("connect", () => conn.write(request));
    conn.on("data", (d) => (out += d));
    conn.on("end", () => resolve(out));
    conn.on("error", reject);
  });
}
const hyprJson = async (what) => JSON.parse(await hypr(`j/${what}`));
const hyprBatch = (cmds) => hypr(`[[BATCH]]${cmds.map((c) => `dispatch ${c}`).join(";")}`);

async function windowOf(kind) {
  const re = new RegExp(cfg.hyprland.classes[kind]);
  return (await hyprJson("clients")).find((c) => re.test(c.class)) ?? null;
}

// Logical monitor size: rotated monitors swap width and height, then scale divides both.
function logical(m) {
  const rotated = m.transform % 2 === 1;
  return {
    h: Math.round((rotated ? m.width : m.height) / m.scale),
    w: Math.round((rotated ? m.height : m.width) / m.scale),
  };
}

const playerUrl = (ch) => `https://player.twitch.tv/?channel=${ch}&parent=twitch.tv&muted=false`;
const chatUrl = (ch) => `https://www.twitch.tv/popout/${ch}/chat?popout=`;

function kindOf(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "player.twitch.tv") return "player";
    if (u.hostname === "www.twitch.tv" && /^\/popout\/[^/]+\/chat/.test(u.pathname)) return "chat";
  } catch {}
  return null;
}

function channelOf(url) {
  const u = new URL(url);
  if (u.hostname === "player.twitch.tv") return (u.searchParams.get("channel") || "").toLowerCase();
  return (u.pathname.split("/")[2] || "").toLowerCase();
}

// decapi returns plain text: "<login> is offline", an uptime like "2 hours, 3 minutes", or an error.
async function liveness(ch) {
  try {
    const res = await fetch(`https://decapi.me/twitch/uptime/${ch}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return "unknown";
    const text = (await res.text()).trim().toLowerCase();
    if (text.endsWith("is offline")) return "offline";
    if (/\d+\s+(second|minute|hour|day)s?/.test(text)) return "live";
  } catch {}
  return "unknown";
}

// Walk the priority list; an unknown result on a higher-priority channel blocks the switch so a
// flaky lookup never drops a live primary in favour of a fallback.
async function pickChannel() {
  for (const ch of cfg.channels) {
    const state = await liveness(ch);
    if (state === "live") return ch;
    if (state === "unknown") return null;
  }
  return cfg.fallback;
}

class Cdp {
  constructor(out, inp) {
    this.out = out;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    // The browser closing or crashing resets the pipe; the child exit handler does cleanup.
    const fail = () => {
      for (const { reject } of this.pending.values()) reject(new Error("browser pipe closed"));
      this.pending.clear();
    };
    inp.on("error", fail).on("close", fail);
    out.on("error", fail);
    let buf = Buffer.alloc(0);
    inp.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let i;
      while ((i = buf.indexOf(0)) !== -1) {
        const msg = JSON.parse(buf.subarray(0, i).toString("utf8"));
        buf = buf.subarray(i + 1);
        this.dispatch(msg);
      }
    });
  }
  dispatch(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      this.handlers.get(msg.method)?.(msg.params);
    }
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.out.write(`${JSON.stringify(msg)}\0`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method, fn) {
    this.handlers.set(method, fn);
  }
}

function browserArgs(extra) {
  const args = [
    `--user-data-dir=${cfg.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...cfg.extraFlags,
  ];
  if (cfg.extensions.length) args.push(`--load-extension=${cfg.extensions.join(",")}`);
  return [...args, ...extra];
}

// A second invocation on the same profile is forwarded to the running browser by Chromium's
// process singleton, which is the only way to get a chromeless --app window after startup.
function openInRunning(extra) {
  spawn(cfg.browser, browserArgs(extra), { stdio: "ignore", detached: true }).unref();
}

// Twitch's web client sends the auth-token cookie as the GQL Authorization header, so one
// cookie is a full login. The token never leaves this process: no logs, no argv, no store.
function readAuthToken() {
  if (!cfg.authTokenFile) return null;
  let token;
  try {
    token = readFileSync(cfg.authTokenFile, "utf8").trim();
  } catch (e) {
    console.error(`twitch-pip: auth token unreadable (${e.code}); keeping profile login`);
    return null;
  }
  if (!/^[a-z0-9]{20,64}$/.test(token)) {
    console.error("twitch-pip: auth token has an unexpected format; keeping profile login");
    return null;
  }
  return token;
}

async function applyAuthToken(cdp, pages) {
  const token = readAuthToken();
  if (!token) return;
  const { cookies } = await cdp.send("Storage.getCookies");
  if (cookies.some((c) => c.name === "auth-token" && c.domain === ".twitch.tv" && c.value === token)) return;
  await cdp.send("Storage.setCookies", {
    cookies: [
      {
        domain: ".twitch.tv",
        expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365,
        name: "auth-token",
        path: "/",
        sameSite: "Lax",
        secure: true,
        value: token,
      },
    ],
  });
  // The first window loaded before the cookie existed.
  for (const targetId of pages()) {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.reload", {}, sessionId);
    await cdp.send("Target.detachFromTarget", { sessionId });
  }
}

async function serve(initial) {
  const server = net.createServer();
  const claimed = await new Promise((resolve) => {
    server.once("error", resolve);
    server.listen(SOCK, () => resolve(null));
  });
  if (claimed) {
    if (claimed.code !== "EADDRINUSE") throw claimed;
    if (await request(initial).then(() => true, () => false)) return;
    rmSync(SOCK, { force: true });
    return serve(initial);
  }

  const desired = (await pickChannel()) || cfg.fallback;
  const first = {
    chat: `--app=${chatUrl(desired)}`,
    login: "https://www.twitch.tv/login",
  }[initial] ?? `--app=${playerUrl(desired)}`;
  const child = spawn(cfg.browser, browserArgs(["--remote-debugging-pipe", first]), {
    stdio: ["ignore", "ignore", "inherit", "pipe", "pipe"],
  });
  const cdp = new Cdp(child.stdio[3], child.stdio[4]);
  const targets = new Map();
  let closing = null;

  const shutdown = () => {
    server.close();
    rmSync(SOCK, { force: true });
    process.exit(0);
  };
  child.on("exit", shutdown);
  process.on("SIGTERM", () => cdp.send("Browser.close").catch(() => child.kill()));

  const find = (kind) => [...targets].find(([, t]) => kindOf(t.url) === kind)?.[0];
  const track = (info) => {
    if (info.type === "page") targets.set(info.targetId, { url: info.url });
  };
  cdp.on("Target.targetCreated", ({ targetInfo }) => track(targetInfo));
  cdp.on("Target.targetInfoChanged", ({ targetInfo }) => track(targetInfo));
  cdp.on("Target.targetDestroyed", ({ targetId }) => {
    targets.delete(targetId);
    // Background extensions can keep Chromium alive with no windows; quit once the last page is gone.
    clearTimeout(closing);
    closing = setTimeout(() => {
      if (targets.size === 0) cdp.send("Browser.close").catch(() => child.kill());
    }, 1500);
  });
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  await applyAuthToken(cdp, () => [find("player"), find("chat")].filter(Boolean));

  const open = (kind) => {
    const ch = channelOf(targets.get(find(kind === "chat" ? "player" : "chat"))?.url ?? playerUrl(desired));
    openInRunning([`--app=${kind === "chat" ? chatUrl(ch) : playerUrl(ch)}`]);
    return `opened ${kind} ${ch}`;
  };

  // Hiding parks the window on a special workspace so the stream, position and size survive.
  // Pinned windows cannot change workspace, so unpin on the way out and pin on the way back.
  const toggle = async (kind) => {
    const id = find(kind);
    if (!id) return open(kind);
    if (!HYPR) return cdp.send("Target.closeTarget", { targetId: id }).then(() => `closed ${kind}`);
    const win = await windowOf(kind);
    if (!win) return `${kind} window not mapped yet`;
    const addr = `address:${win.address}`;
    if (win.workspace.name === HIDDEN) {
      const { id: ws } = await hyprJson("activeworkspace");
      await hyprBatch([`movetoworkspacesilent ${ws},${addr}`, `pin ${addr}`]);
      return `shown ${kind}`;
    }
    await hyprBatch([...(win.pinned ? [`pin ${addr}`] : []), `movetoworkspacesilent ${HIDDEN},${addr}`]);
    return `hidden ${kind}`;
  };

  const reset = async () => {
    if (!HYPR) return "reset needs Hyprland";
    const monitors = await hyprJson("monitors");
    const focused = monitors.find((m) => m.focused) ?? monitors[0];
    const { margin, sizes } = cfg.hyprland;
    const out = [];
    for (const kind of ["player", "chat"]) {
      const win = await windowOf(kind);
      if (!win) continue;
      const mon = monitors.find((m) => m.id === win.monitor) ?? focused;
      const { w, h } = logical(mon);
      const s = sizes[kind];
      const below = kind === "chat" ? sizes.player.height + margin : 0;
      const x = mon.x + w - s.width - margin;
      const y = mon.y + h - s.height - margin - below;
      const addr = `address:${win.address}`;
      await hyprBatch([
        ...(win.floating ? [] : [`setfloating ${addr}`]),
        `resizewindowpixel exact ${s.width} ${s.height},${addr}`,
        `movewindowpixel exact ${x} ${y},${addr}`,
      ]);
      out.push(kind);
    }
    return out.length ? `reset ${out.join(" ")}` : "nothing to reset";
  };

  const handle = async (line) => {
    switch (line) {
      case "toggle":
        return toggle("player");
      case "chat":
        return toggle("chat");
      case "login":
        await cdp.send("Target.createTarget", { url: "https://www.twitch.tv/login", newWindow: true });
        return "opened login";
      case "reset":
        return reset();
      case "status":
        return [...targets.values()].map((t) => `${kindOf(t.url) ?? "page"} ${t.url}`).join("\n") || "no pages";
      case "quit":
        await cdp.send("Browser.close");
        return "quit";
      default:
        return `unknown command: ${line}`;
    }
  };

  server.on("connection", (conn) => {
    let data = "";
    conn.on("data", (d) => {
      data += d;
      if (!data.includes("\n")) return;
      handle(data.split("\n")[0].trim())
        .catch((e) => `error: ${e.message}`)
        .then((reply) => conn.end(`${reply}\n`));
    });
  });

  const retarget = async () => {
    const ch = await pickChannel();
    if (!ch) return;
    for (const kind of ["player", "chat"]) {
      const id = find(kind);
      if (!id || channelOf(targets.get(id).url) === ch) continue;
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: id, flatten: true });
      await cdp.send("Page.navigate", { url: kind === "chat" ? chatUrl(ch) : playerUrl(ch) }, sessionId);
      await cdp.send("Target.detachFromTarget", { sessionId });
    }
  };
  const loop = () =>
    retarget()
      .catch((e) => console.error(`twitch-pip: retarget failed: ${e.message}`))
      .finally(() => setTimeout(loop, cfg.pollSeconds * 1000));
  setTimeout(loop, cfg.pollSeconds * 1000);
}

function request(command) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(SOCK);
    let out = "";
    conn.on("connect", () => conn.write(`${command}\n`));
    conn.on("data", (d) => (out += d));
    conn.on("end", () => resolve(out.trim()));
    conn.on("error", reject);
  });
}

if (cmd === "serve") {
  const initial = process.argv[4] ?? "toggle";
  await serve(COMMANDS.has(initial) ? initial : "toggle");
} else if (COMMANDS.has(cmd)) {
  try {
    console.log(await request(cmd));
  } catch (e) {
    if (!["ENOENT", "ECONNREFUSED"].includes(e.code)) throw e;
    if (cmd === "status" || cmd === "quit" || cmd === "reset") {
      console.log("not running");
    } else {
      spawn(process.execPath, [process.argv[1], configPath, "serve", cmd], {
        stdio: "ignore",
        detached: true,
      }).unref();
      console.log(`starting (${cmd})`);
    }
  }
} else {
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}
