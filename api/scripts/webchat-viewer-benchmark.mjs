/** Disposable real-Chromium/Steel benchmark. Never connects to an installed service. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, mkdtemp, copyFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { pathToFileURL } from "node:url";

const options = Object.fromEntries(
  process.argv.slice(2).map((v) => v.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)),
);
assert(
  options["steel-root"] && options.launch && options.output,
  "Supply --steel-root= --launch= --output=",
);
const steelRoot = resolve(options["steel-root"]);
const output = resolve(options.output);
await mkdir(output, { recursive: true });
const require = createRequire(join(steelRoot, "package.json"));
const puppeteer = require("puppeteer-core");
const { WebSocket, WebSocketServer } = require("ws");
const launch = JSON.parse(await readFile(options.launch, "utf8"));
const seconds = Number(options.seconds || 8);
assert(seconds >= 3 && seconds <= 120);
const policy = options.policy || "baseline";
assert(["baseline", "normal"].includes(policy));
const backgroundFlags = new Set([
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser, xvfb, castServer, site;
const sockets = new Set();
let results = {
  policy,
  seconds,
  source: "Steel 75af2ba99026db454ea8605a4c66bcabff9deef4",
  candidateRevision: execFileSync("git", ["-C", steelRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  candidateDirty: Boolean(execFileSync("git", ["-C", steelRoot, "status", "--porcelain"], { encoding: "utf8" }).trim()),
  cases: [],
};

async function tree(root) {
  const selected = new Map(),
    pending = [root];
  while (pending.length) {
    const pid = pending.pop();
    if (selected.has(pid)) continue;
    try {
      const raw = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
      selected.set(pid, Number(fields[11]) + Number(fields[12]));
      const children = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
      pending.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));
    } catch {
      /* A process may exit during the snapshot. */
    }
  }
  return selected;
}

async function measure(name, viewers = []) {
  const ticksPerSecond = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
  let before = await tree(browser.process().pid),
    cpuTicks = 0;
  const start = performance.now(),
    nodeStart = process.cpuUsage();
  const frameStart = viewers.map((v) => v.frames);
  while (performance.now() - start < seconds * 1000) {
    await sleep(250);
    const after = await tree(browser.process().pid);
    for (const [pid, ticks] of after)
      if (before.has(pid)) cpuTicks += Math.max(0, ticks - before.get(pid));
    before = after;
  }
  const elapsed = (performance.now() - start) / 1000;
  const cpu = process.cpuUsage(nodeStart);
  const row = {
    name,
    duration: elapsed,
    chromeCores: cpuTicks / ticksPerSecond / elapsed,
    castAndHarnessCores: (cpu.user + cpu.system) / 1e6 / elapsed,
    viewers: viewers.map((v, i) => ({
      frames: v.frames - frameStart[i],
      bytes: v.bytes,
      lastPageId: v.lastPageId,
    })),
  };
  results.cases.push(row);
  console.log(JSON.stringify(row));
  await writeFile(join(output, `${policy}.json`), JSON.stringify(results, null, 2));
}

function fixture(url) {
  const label = url.searchParams.get("chat") || "idle";
  return `<!doctype html><meta charset="utf-8"><title>Viewer lab ${label}</title>
    <style>body{background:${
      label === "A" ? "#c92a2a" : "#1864ab"
    };color:white;font:20px sans-serif}input{width:140px;margin:3px}</style>
    <h1>Chat ${label}</h1><button id="increment" onclick="this.textContent=++window.clicks">0</button>
    <canvas id="animation" width="800" height="100"></canvas>
    <input id="answer" aria-label="Answer"><div id="fields"></div><output id="ticks"></output>
    <script>window.clicks=0;window.ticks=0;window.busy=false;window.animate=false;
    fields.innerHTML=Array.from({length:120},(_,i)=>'<input aria-label="Field '+i+'">').join('');
    setInterval(()=>{if(window.busy){const end=performance.now()+2;while(performance.now()<end){} window.ticks++;ticks.textContent=window.ticks;}},20);
    const ctx=animation.getContext('2d');function draw(t){if(window.animate){ctx.fillStyle='black';ctx.fillRect(0,0,800,100);ctx.fillStyle='white';ctx.fillRect((t/5)%750,10,50,80);}requestAnimationFrame(draw);}requestAnimationFrame(draw);
    </script>`;
}

async function view(page) {
  const id = page.target()._getTargetInfo().targetId;
  const ws = new WebSocket(
    `ws://127.0.0.1:${
      castServer.address().port
    }/v1/sessions/lab/cast?pageId=${id}&webchatManaged=2&width=1280&height=720&deviceScaleFactor=1`,
  );
  sockets.add(ws);
  const state = { ws, frames: 0, bytes: 0, lastPageId: null, acks: new Map() };
  state.ready = new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error("No first frame")), 12000);
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const p = JSON.parse(raw.toString());
      if (p.type === "webchatCastReady")
        ws.send(
          JSON.stringify({
            type: "webchatViewportApplied",
            pageId: id,
            viewport: { width: 1280, height: 720, mobile: false, deviceScaleFactor: 1 },
          }),
        );
      if (p.type === "webchatInputApplied") state.acks.set(p.requestId, p.ok);
      if (p.data) {
        assert.equal(p.pageId, id, "Cross-tab frame");
        assert.equal(p.metadata.deviceWidth, 1280);
        assert.equal(p.metadata.deviceHeight, 720);
        state.frames++;
        state.bytes += raw.length;
        state.lastPageId = p.pageId;
        state.lastData = p.data;
        clearTimeout(timeout);
        resolveReady(state);
      }
    });
  });
  await state.ready;
  return state;
}

async function input(viewer, payload, id) {
  viewer.ws.send(JSON.stringify({ ...payload, webchatInputId: id }));
  const deadline = performance.now() + 5000;
  while (!viewer.acks.has(id) && performance.now() < deadline) await sleep(20);
  assert.equal(viewer.acks.get(id), true, "Input delivery not acknowledged");
}

async function closeViews(viewers) {
  await Promise.all(
    viewers.map(async (v) => {
      v.ws.close();
      if (v.ws.readyState !== WebSocket.CLOSED) await once(v.ws, "close");
      sockets.delete(v.ws);
    }),
  );
  await sleep(700);
}

try {
  xvfb = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1280x720x24", "-nolisten", "tcp"], {
    stdio: ["ignore", "ignore", "ignore", "pipe"],
  });
  const [display] = await once(xvfb.stdio[3], "data");
  const profile = await mkdtemp(join(output, `${policy}-profile-`));
  assert(
    launch.nativeHostManifest,
    "Supply the existing extension native-host manifest in the launch fixture",
  );
  await mkdir(join(profile, "NativeMessagingHosts"));
  await copyFile(
    launch.nativeHostManifest,
    join(profile, "NativeMessagingHosts/com.openai.codexextension.json"),
  );
  const args = launch.args.filter((a) => policy === "baseline" || !backgroundFlags.has(a));
  args.push(
    `--load-extension=${launch.extension}`,
    `--disable-extensions-except=${launch.extension}`,
    "--remote-debugging-port=0",
  );
  browser = await puppeteer.launch({
    executablePath: launch.executable,
    headless: false,
    ignoreDefaultArgs: true,
    defaultViewport: null,
    userDataDir: profile,
    args,
    env: { ...process.env, DISPLAY: `:${display.toString().trim()}` },
  });
  results.launch = {
    executable: launch.executable,
    extension: launch.extension,
    args,
    browserVersion: await browser.version(),
  };
  const cdpPort = new URL(browser.wsEndpoint()).port;
  castServer = createServer();
  castServer.listen(0, "127.0.0.1");
  await once(castServer, "listening");
  process.env.HOST = "127.0.0.1";
  process.env.PORT = String(castServer.address().port);
  // Only the fixture address changes: the installed Steel browser is never contacted.
  const moduleDir = await mkdtemp(join(steelRoot, "api/build/plugins/browser-socket/lab-"));
  const handlerPath = "api/src/plugins/browser-socket/casting.handler.ts";
  const source =
    policy === "baseline"
      ? execFileSync(
          "git",
          ["-C", steelRoot, "show", `${results.source.split(" ")[1]}:${handlerPath}`],
          { encoding: "utf8" },
        )
      : await readFile(join(steelRoot, handlerPath), "utf8");
  const ts = require("typescript");
  let handler = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  handler = handler
    .replaceAll("../../env.js", "../../../env.js")
    .replaceAll("../../utils/casting.js", "../../../utils/casting.js")
    .replaceAll("../../utils/shared-scan.js", "../../../utils/shared-scan.js")
    .replaceAll("127.0.0.1:9222", `127.0.0.1:${cdpPort}`);
  const modulePath = join(moduleDir, "casting.handler.mjs");
  await writeFile(modulePath, handler);
  const { handleCastSession } = await import(pathToFileURL(modulePath));
  const wss = new WebSocketServer({ noServer: true });
  castServer.on("upgrade", (req, socket, head) => {
    if (req.url === "/") {
      wss.handleUpgrade(req, socket, head, (client) => {
        const remote = new WebSocket(browser.wsEndpoint());
        const pending = [];
        client.on("message", (data) =>
          remote.readyState === WebSocket.OPEN
            ? remote.send(data.toString())
            : pending.push(data.toString()),
        );
        remote.on("open", () => {
          for (const data of pending) remote.send(data);
        });
        remote.on("message", (data) => {
          if (client.readyState === WebSocket.OPEN) client.send(data.toString());
        });
        client.on("close", () => remote.close());
        remote.on("close", () => client.close());
        remote.on("error", () => client.close());
        client.on("error", () => remote.close());
      });
      return;
    }
    void handleCastSession(
      req,
      socket,
      head,
      wss,
      { activeSession: { dimensions: { width: 1280, height: 720 } } },
      {},
    );
  });
  site = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fixture(new URL(req.url, "http://localhost")));
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const pages = [];
  for (let i = 0; i < 16; i++) {
    const page = await browser.newPage();
    await page.goto(
      `http://127.0.0.1:${site.address().port}/?chat=${i === 0 ? "A" : i === 1 ? "B" : i}`,
    );
    const cdp = await page.createCDPSession();
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.detach();
    pages.push(page);
  }
  await pages[0].bringToFront();
  await sleep(12000);
  results.extensionWorker = browser
    .targets()
    .some((t) => t.url().startsWith("chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg/"));
  assert(results.extensionWorker, "ChatGPT extension did not load");
  await measure("16-static-tabs-no-viewer");
  await Promise.all(
    pages.map((p) =>
      p.evaluate(() => {
        window.busy = true;
      }),
    ),
  );
  await sleep(12000);
  await measure("16-timer-tabs-no-viewer");
  await Promise.all(
    pages.map((p) =>
      p.evaluate(() => {
        window.busy = false;
      }),
    ),
  );
  let viewers = [await view(pages[0]), await view(pages[1])];
  await measure("two-chat-viewers", viewers);
  await pages[0].focus("#answer");
  await input(
    viewers[0],
    { type: "keyEvent", event: { type: "char", text: "ONLY-A-✓" } },
    "input-A",
  );
  assert.equal(await pages[0].$eval("#answer", (e) => e.value), "ONLY-A-✓");
  assert.equal(await pages[1].$eval("#answer", (e) => e.value), "");
  results.inputIsolation = true;
  await writeFile(join(output, `${policy}-chat-A.jpg`), Buffer.from(viewers[0].lastData, "base64"));
  await writeFile(join(output, `${policy}-chat-B.jpg`), Buffer.from(viewers[1].lastData, "base64"));
  await closeViews(viewers);
  viewers = [await view(pages[0])];
  await pages[0].bringToFront();
  await pages[0].evaluate(() => {
    window.animate = true;
  });
  await measure("foreground-animation", viewers);
  assert(viewers[0].frames > seconds * 5, "Foreground animation below 5 FPS");
  await pages[0].evaluate(() => {
    window.animate = false;
  });
  await closeViews(viewers);
  viewers = await Promise.all(Array.from({ length: 4 }, () => view(pages[0])));
  await measure("four-viewers-one-chat", viewers);
  await closeViews(viewers);
  viewers = await Promise.all(pages.map(view));
  await measure("16-chat-viewers", viewers);
  assert(
    viewers.every((v) => v.frames >= 2),
    "A concurrent viewer stalled",
  );
  await closeViews(viewers);
  await measure("all-viewers-disconnected-tabs-preserved");
  assert.equal(
    (await browser.pages()).filter((p) => p.url().includes(`127.0.0.1:${site.address().port}`))
      .length,
    16,
  );
  for (let i = 0; i < 12; i++) await closeViews([await view(pages[i % 2])]);
  results.reconnects = 12;
  await measure("after-12-chat-switches");
  await writeFile(
    join(output, "fixture.json"),
    JSON.stringify(
      {
        url: pages[0].url(),
        secondUrl: pages[1].url(),
        browserPid: browser.process().pid,
        debugPort: cdpPort,
        extensionWorker: results.extensionWorker,
      },
      null,
      2,
    ),
  );
  results.completed = true;
  if (options.hold) {
    console.log("HOLDING owned fixture for extension UI verification");
    const until = performance.now() + Math.min(600, Number(options.hold)) * 1000;
    while (performance.now() < until) {
      if (
        await access(join(output, "release")).then(
          () => true,
          () => false,
        )
      )
        break;
      await sleep(500);
    }
  }
} finally {
  for (const ws of sockets) ws.terminate();
  if (browser) await browser.close();
  if (xvfb && xvfb.exitCode === null) {
    xvfb.kill();
    await once(xvfb, "exit").catch(() => {});
  }
  if (castServer) {
    castServer.closeAllConnections();
    castServer.close();
  }
  if (site) {
    site.closeAllConnections();
    site.close();
  }
  await writeFile(join(output, `${policy}.json`), JSON.stringify(results, null, 2));
}
