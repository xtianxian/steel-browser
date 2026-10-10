import { IncomingMessage } from "http";
import puppeteer, { Browser, CDPSession, Page, Target } from "puppeteer-core";
import { Duplex } from "stream";
import WebSocket, { Server } from "ws";

import { env } from "../../env.js";
import { SessionService } from "../../services/session.service.js";
import {
  CloseTabEvent,
  GetSelectedTextEvent,
  KeyEvent,
  MouseEvent,
  NavigationEvent,
  PageInfo,
  ResizeEvent,
} from "../../types/casting.js";
import { getPageFavicon, navigatePage } from "../../utils/casting.js";

function targetInfo(target: Target): { targetId: string; type: string; title: string } {
  // The pinned Puppeteer version exposes this metadata without a page evaluation.
  return (target as Target & { _getTargetInfo(): { targetId: string; type: string; title: string } })._getTargetInfo();
}

// The pinned target/session chain lets a cast attach only its own OOP frames.
// Unattached discovery entries have no session and must not delay startup.
type CastChildSession = CDPSession & { _target(): Target; parentSession(): CastChildSession | undefined };
function isOwnedChildFrame(target: Target, pageId: string | null): boolean {
  if (!pageId) return false;
  const child = target as Target & { _session?: () => CastChildSession | undefined };
  let parent = child._session?.()?.parentSession();
  for (let depth = 0; parent && depth < 16; depth++, parent = parent.parentSession()) {
    if (targetInfo(parent._target()).targetId === pageId) return true;
  }
  return false;
}

// WEBCHAT_EDITABLE_SCANNER_START
// DOM search pierces author shadow roots. Each out-of-process frame has its
// own session; only bounded geometry crosses into the viewer, never values.
type EditableRect = { x: number; y: number; width: number; height: number };
type EditableFrame = ReturnType<Page["mainFrame"]> & { client: CDPSession };
const editableCommands = { timeout: 800 };

async function scanEditableRects(page: Page): Promise<EditableRect[]> {
  const sessions = new Map<CDPSession, EditableFrame>();
  for (const frame of page.frames() as EditableFrame[]) {
    if (!sessions.has(frame.client)) sessions.set(frame.client, frame);
  }
  const result: EditableRect[] = [];
  for (const [client, frame] of [...sessions].slice(0, 16)) {
    const remaining = 256 - result.length;
    if (!remaining) break;
    const rects = await scanEditableSession(client, frame, remaining).catch(() => []);
    result.push(...rects);
  }
  return result;
}

async function editableFrameOffset(frame: EditableFrame): Promise<{ x: number; y: number }> {
  if (!frame.parentFrame()) return { x: 0, y: 0 };
  const owner = await frame.frameElement();
  if (!owner) throw new Error("Detached editable frame");
  try {
    const box = await owner.boxModel();
    if (!box) throw new Error("Hidden editable frame");
    return box.content[0];
  } finally { await owner.dispose(); }
}

async function scanEditableSession(client: CDPSession, frame: EditableFrame, limit: number): Promise<EditableRect[]> {
  const offset = await editableFrameOffset(frame);
  await client.send("DOM.getDocument", { depth: 0, pierce: true }, editableCommands);
  const search = await client.send("DOM.performSearch", {
    query: "input,textarea,[contenteditable]", includeUserAgentShadowDOM: false,
  }, editableCommands);
  try {
    if (!search.resultCount) return [];
    const { nodeIds } = await client.send("DOM.getSearchResults", {
      searchId: search.searchId, fromIndex: 0, toIndex: Math.min(search.resultCount, 256),
    }, editableCommands);
    const rects: EditableRect[] = [];
    for (let i = 0; i < nodeIds.length && rects.length < limit; i += 16) {
      const batch = await Promise.all(nodeIds.slice(i, i + 16).map((nodeId) =>
        editableNodeRect(client, nodeId, offset).catch(() => null)));
      rects.push(...batch.filter((rect): rect is EditableRect => rect !== null));
    }
    return rects.slice(0, limit);
  } finally {
    await client.send("DOM.discardSearchResults", { searchId: search.searchId }, editableCommands).catch(() => {});
  }
}

// Executes inside the node's own document, including closed author shadow roots.
function editableNodeVisible(this: HTMLElement): boolean {
  const input = this instanceof HTMLInputElement;
  const textarea = this instanceof HTMLTextAreaElement;
  if (this.matches(":disabled, [inert]")) return false;
  if (input && (!/^(text|search|email|url|tel|password|number)$/.test(this.type) || this.readOnly)) return false;
  if (textarea && this.readOnly) return false;
  if (!input && !textarea && !this.isContentEditable) return false;
  const rect = this.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return false;
  const x = (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2;
  const y = (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2;
  if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) return false;
  let node: Element = this;
  for (let root = node.getRootNode(); root instanceof ShadowRoot; root = node.getRootNode()) {
    if (!node.contains(root.elementFromPoint(x, y))) return false;
    node = root.host;
  }
  return node.contains(this.ownerDocument.elementFromPoint(x, y));
}

async function editableNodeRect(client: CDPSession, nodeId: number, offset: { x: number; y: number }): Promise<EditableRect | null> {
  const { object } = await client.send("DOM.resolveNode", { nodeId }, editableCommands);
  if (!object.objectId) return null;
  try {
    const visible = await client.send("Runtime.callFunctionOn", {
      objectId: object.objectId, functionDeclaration: editableNodeVisible.toString(),
      returnByValue: true,
    }, editableCommands);
    if (visible.result.value !== true) return null;
    const { model } = await client.send("DOM.getBoxModel", { nodeId }, editableCommands);
    const xs = model.border.filter((_, index) => index % 2 === 0);
    const ys = model.border.filter((_, index) => index % 2 === 1);
    return { x: Math.min(...xs) + offset.x, y: Math.min(...ys) + offset.y,
      width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  } finally { await client.send("Runtime.releaseObject", { objectId: object.objectId }, editableCommands).catch(() => {}); }
}
// WEBCHAT_EDITABLE_SCANNER_END

type CastViewport = { width: number; height: number; mobile: boolean; deviceScaleFactor: number };

// Shared across cast connections, including initial setup and reconnect.
const targetViewportTransitions = new Map<string, Promise<void>>();
function serializeTargetViewport(targetId: string, change: () => Promise<void>): Promise<void> {
  const previous = targetViewportTransitions.get(targetId) || Promise.resolve();
  const next = previous.catch(() => {}).then(change);
  targetViewportTransitions.set(targetId, next);
  void next.finally(() => {
    if (targetViewportTransitions.get(targetId) === next) targetViewportTransitions.delete(targetId);
  }).catch(() => {});
  return next;
}

type ManagedViewportEvent = { type: "webchatViewportApplied"; pageId: string; viewport: CastViewport };


function castMetrics({ width, height, mobile, deviceScaleFactor }: CastViewport) {
  return {
    screenWidth: width,
    screenHeight: height,
    width,
    height,
    mobile,
    deviceScaleFactor,
    screenOrientation: height >= width
      ? { angle: 0, type: "portraitPrimary" as const }
      : { angle: 90, type: "landscapePrimary" as const },
  };
}

function castOptions({ width, height }: CastViewport) {
  return { format: "jpeg" as const, quality: 75, maxWidth: width, maxHeight: height };
}

function jpegDimensions(data: string): { width: number; height: number } | null {
  const image = Buffer.from(data, "base64");
  if (image[0] !== 0xff || image[1] !== 0xd8) return null;
  for (let offset = 2; offset + 9 < image.length;) {
    if (image[offset] !== 0xff) return null;
    const marker = image[offset + 1];
    if (marker === 0xda || marker === 0xd9) return null;
    const length = image.readUInt16BE(offset + 2);
    if (length < 2 || offset + length + 2 > image.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: image.readUInt16BE(offset + 5), width: image.readUInt16BE(offset + 7) };
    }
    offset += length + 2;
  }
  return null;
}

function captureBackgroundPage(pageId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${pageId}`, {
      headers: { Origin: "http://127.0.0.1:8793" },
    });
    let finished = false;
    const finish = (error: Error | null, data?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error);
      else resolve(data || "");
    };
    const timeout = setTimeout(() => finish(new Error("Browser capture timed out")), 3000);
    socket.once("open", () => socket.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot",
      params: { format: "jpeg", quality: 75, captureBeyondViewport: false, fromSurface: true } })));
    socket.on("message", (raw) => {
      try {
        const response = JSON.parse(raw.toString());
        if (response.id === 1) finish(response.error ? new Error(response.error.message) : null, response.result?.data);
      } catch (error) { finish(error instanceof Error ? error : new Error("Invalid browser capture")); }
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => finish(new Error("Browser capture closed")));
  });
}

export async function handleCastSession(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: Server,
  sessionService: SessionService,
  params: Record<string, string> | undefined,
): Promise<void> {
  const id = request.url?.split("/sessions/")[1].split("/cast")[0];

  if (!id) {
    console.error("Cast Session ID not found");
    socket.destroy();
    return;
  }

  const session = await sessionService.activeSession;
  if (!session) {
    console.error(`Cast Session ${id} not found`);
    socket.destroy();
    return;
  }

  const queryParams = new URLSearchParams(request.url?.split("?")[1] || "");
  const requestedPageId = params?.pageId || queryParams.get("pageId") || null;
  const requestedPageIndex = params?.pageIndex || queryParams.get("pageIndex") || null;

  const tabDiscoveryMode =
    queryParams.get("tabInfo") === "true" || (!requestedPageId && !requestedPageIndex);

  const webchatManaged = queryParams.get("webchatManaged") === "2";
  const requestedWidth = Number(queryParams.get("width"));
  const requestedHeight = Number(queryParams.get("height"));
  const requestedScale = Number(queryParams.get("deviceScaleFactor"));
  const hasViewport = Number.isInteger(requestedWidth) && requestedWidth >= 320 && requestedWidth <= 3840
    && Number.isInteger(requestedHeight) && requestedHeight >= 240 && requestedHeight <= 2160
    && Number.isFinite(requestedScale) && requestedScale >= 1 && requestedScale <= 4;
  const isMobile = hasViewport ? queryParams.get("mobile") === "true" : session.deviceConfig?.device === "mobile";
  const defaultDimensions = isMobile ? { width: 508, height: 1074 } : { width: 1920, height: 1080 };
  const { height, width } = hasViewport ? { width: requestedWidth, height: requestedHeight }
    : (session.dimensions as { width: number; height: number }) ?? defaultDimensions;
  const deviceScaleFactor = hasViewport ? requestedScale : isMobile ? 3 : 1;

  wss.handleUpgrade(request, socket, head, async (ws) => {
    let browser: Browser | null = null;
    let targetPage: Page | null = null;
    let targetClient: CDPSession | null = null;
    let targetPageId: string | null = null;
    let currentViewport: CastViewport = { width, height, mobile: isMobile, deviceScaleFactor };
    let editableRects: EditableRect[] = [];
    let editableScanPending = false;
    let editableScanInterval: NodeJS.Timeout | null = null;
    let frameWatchdog: NodeJS.Timeout | null = null;
    let fallbackInFlight = false;
    let lastFrameAt = Date.now();
    let lastTitle = "";
    let lastFavicon = "";
    const changeViewport = (change: () => Promise<void>): Promise<void> => {
      if (!targetPageId) return Promise.reject(new Error("Browser target unavailable"));
      return serializeTargetViewport(targetPageId, change);
    };

    const activePages = new Map<string, Target>();

    let heartbeatInterval: NodeJS.Timeout | null = null;

    const handleSessionCleanup = () => {
      if (frameWatchdog) {
        clearInterval(frameWatchdog);
        frameWatchdog = null;
      }
      if (editableScanInterval) {
        clearInterval(editableScanInterval);
        editableScanInterval = null;
      }
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }

      if (targetPage) {
        targetPage.removeAllListeners("framenavigated");
      }

      // Clean up screencast
      if (targetClient) {
        try {
          targetClient.send("Page.stopScreencast").catch((err) => {
            // Ignore errors about closed targets
            if (!err.message?.includes("Target closed")) {
              console.error("Error stopping screencast:", err);
            }
          });

          targetClient.detach().catch((err) => {
            // Ignore errors about closed targets
            if (!err.message?.includes("Target closed")) {
              console.error("Error detaching client:", err);
            }
          });

          targetClient = null;
        } catch (err) {
          console.error("Error during screencast cleanup:", err);
        }
      }

      // Disconnect browser
      if (browser) {
        try {
          browser.disconnect().catch((err) => {
            console.error("Error disconnecting browser:", err);
          });
          browser = null;
        } catch (err) {
          console.error("Error during browser disconnect:", err);
        }
      }

      // Force garbage collection if available (Node.js with --expose-gc flag)
      if (global.gc) {
        try {
          global.gc();
        } catch (err) {
          console.error("Error during garbage collection:", err);
        }
      }
    };

    ws.on("close", handleSessionCleanup);
    ws.on("error", handleSessionCleanup);

    const sendTabList = async () => {
      try {
        if (ws.readyState !== WebSocket.OPEN || !tabDiscoveryMode) return;

        const tabList: PageInfo[] = [];

        for (const [pageId, page] of activePages.entries()) {
          tabList.push({
            id: pageId,
            url: page.url(),
            title: targetInfo(page).title,
            favicon: "",
          });
        }

        ws.send(
          JSON.stringify({
            type: "tabList",
            tabs: tabList,
            firstTabId: tabList.length > 0 ? tabList[0].id : null,
          }),
        );
      } catch (error) {
        console.error("Error sending tab list:", error);
      }
    };

    const findTargetPage = async (
      pages: Page[],
    ): Promise<{ page: Page; pageId: string } | null> => {
      if (tabDiscoveryMode) return null; // No target page in tab discovery mode

      if (requestedPageId) {
        for (const page of pages) {
          try {
            //@ts-expect-error
            const pageId = page.target()._targetId;
            if (pageId === requestedPageId) {
              return { page, pageId };
            }
          } catch (err) {
            console.error("Error accessing page target ID:", err);
          }
        }
      } else if (requestedPageIndex) {
        const index = parseInt(requestedPageIndex, 10);
        if (index >= 0 && index < pages.length) {
          const page = pages[index];
          //@ts-expect-error
          const pageId = page.target()._targetId;
          return { page, pageId };
        }
      }

      return null;
    };

    try {
      browser = await puppeteer.connect({
        browserWSEndpoint: `ws://${env.HOST}:${env.PORT}`,
        defaultViewport: null,
        protocolTimeout: 8000,
        // Keep unrelated out-of-process frames out of cast initialization.
        // Attach descendants of the requested page for editable-field metadata.
        // Chrome tab targets must remain attached to discover their child page.
        targetFilter: (target) => {
          const info = targetInfo(target);
          return info.type === "browser" || info.type === "tab"
            || (info.type === "page" && (!requestedPageId || info.targetId === requestedPageId))
            || (info.type === "iframe" && isOwnedChildFrame(target, requestedPageId));
        },
      });

      if (!browser) {
        console.error("Failed to connect to browser");
        socket.destroy();
        return;
      }

      if (ws.readyState !== WebSocket.OPEN) { handleSessionCleanup(); return; }

      if (tabDiscoveryMode) {
        for (const target of browser.targets().filter((item) => item.type() === "page")) {
          activePages.set(targetInfo(target).targetId, target);
        }

        // Initial tab list
        await sendTabList();

        // Setup page creation/deletion tracking
        browser.on("targetcreated", async (target) => {
          if (target.type() === "page") {
            try {
              activePages.set(targetInfo(target).targetId, target);
              await sendTabList();
            } catch (err) {
              console.error("Error handling new target:", err);
            }
          }
        });

        browser.on("targetdestroyed", async (target) => {
          if (target.type() === "page") {
            try {
              //@ts-expect-error
              const pageId = target._targetId;
              if (activePages.has(pageId)) {
                activePages.delete(pageId);

                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: "tabClosed",
                      pageId,
                    }),
                  );

                  await sendTabList();
                }
              }
            } catch (err) {
              console.error("Error handling destroyed target:", err);
            }
          }
        });

        // Setup heartbeat to detect dead connections
        heartbeatInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.ping();
            } catch (err) {
              console.error("Error sending ping:", err);
              handleSessionCleanup();
            }
          } else {
            handleSessionCleanup();
          }
        }, 30000);

        return;
      } else {
        const targetResult = await findTargetPage(await browser.pages());

        if (!targetResult) {
          console.error(
            `Target page not found for ${
              requestedPageId ? `pageId=${requestedPageId}` : `pageIndex=${requestedPageIndex}`
            }`,
          );
          socket.destroy();
          return;
        }

        targetPage = targetResult.page;
        targetPageId = targetResult.pageId;

        if (!webchatManaged) await targetPage.bringToFront();

        // Setup screencast for the target page
        targetClient = await targetPage.target().createCDPSession();
        if (ws.readyState !== WebSocket.OPEN) { handleSessionCleanup(); return; }
        void getPageFavicon(targetPage).then((favicon) => { lastFavicon = favicon || ""; }).catch(() => {});

        ws.on("message", async (message) => {
          let webchatInputId: string | undefined;
          try {
            const envelope = JSON.parse(message.toString());
            if (webchatManaged && typeof envelope.webchatInputId === "string") webchatInputId = envelope.webchatInputId;
            const data:
              | MouseEvent
              | KeyEvent
              | NavigationEvent
              | CloseTabEvent
              | GetSelectedTextEvent
              | ResizeEvent
              | ManagedViewportEvent = JSON.parse(message.toString());
            const { type } = data;

            if (!targetClient || !targetPage) {
              console.error("No target page or client available for input handling");
              return;
            }

            switch (type) {
              case "webchatViewportApplied": {
                if (!webchatManaged || data.pageId !== targetPageId) break;
                const viewport = (data as ManagedViewportEvent).viewport;
                if (!viewport || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height)
                    || viewport.width < 320 || viewport.width > 3840 || viewport.height < 240 || viewport.height > 2160) break;
                await changeViewport(async () => {
                  const client = targetClient;
                  if (!client) throw new Error("Browser target disconnected");
                  await client.send("Page.stopScreencast");
                  currentViewport = viewport;
                  await client.send("Page.startScreencast", castOptions(viewport));
                });
                break;
              }
              case "resize": {
                if (webchatManaged) break;
                const { width: nextWidth, height: nextHeight, mobile, deviceScaleFactor, revision } = data as ResizeEvent;
                if (data.pageId !== targetPageId) break;
                if (!Number.isInteger(nextWidth) || !Number.isInteger(nextHeight)
                    || nextWidth < 320 || nextWidth > 3840 || nextHeight < 240 || nextHeight > 2160
                    || !Number.isFinite(deviceScaleFactor) || deviceScaleFactor < 1 || deviceScaleFactor > 4) break;
                const nextViewport = { width: nextWidth, height: nextHeight, mobile: Boolean(mobile), deviceScaleFactor };
                try {
                  await changeViewport(async () => {
                    const client = targetClient;
                    if (!client) throw new Error("Browser target disconnected");
                    await client.send("Page.stopScreencast");
                    await client.send("Page.setDeviceMetricsOverride", castMetrics(nextViewport));
                    await client.send("Page.startScreencast", castOptions(nextViewport));
                    currentViewport = nextViewport;
                  });
                  ws.send(JSON.stringify({ type: "viewportApplied", pageId: targetPageId, revision }));
                } catch (error) {
                  ws.send(JSON.stringify({ type: "viewportFailed", pageId: targetPageId, revision }));
                  console.error("Could not resize browser viewport:", error);
                }
                break;
              }
              case "mouseEvent": {
                const { event } = data as MouseEvent;
                await targetClient.send("Input.dispatchMouseEvent", {
                  type: event.type,
                  x: event.x,
                  y: event.y,
                  button: event.button,
                  buttons: event.buttons ?? (event.type === "mouseReleased" || event.button === "none" ? 0 : 1),
                  clickCount: event.clickCount || 1,
                  modifiers: event.modifiers || 0,
                  deltaX: event.deltaX,
                  deltaY: event.deltaY,
                });
                break;
              }
              case "keyEvent": {
                const { event } = data as KeyEvent;
                if (event.type === "char") {
                  // Committed IME/paste text is not a physical key. dispatchKeyEvent
                  // rejects longer Unicode sequences (including joined emoji).
                  await targetClient.send("Input.insertText", { text: event.text || "" });
                  break;
                }
                await targetClient.send("Input.dispatchKeyEvent", {
                  type: event.type,
                  text: event.text,
                  unmodifiedText: event.text ? event.text.toLowerCase() : undefined,
                  code: event.code,
                  key: event.key,
                  windowsVirtualKeyCode: event.keyCode,
                  nativeVirtualKeyCode: event.keyCode,
                  modifiers: event.modifiers || 0,
                  autoRepeat: false,
                  isKeypad: false,
                  isSystemKey: false,
                });
                break;
              }
              case "navigation": {
                const { event } = data as NavigationEvent;
                await navigatePage(event, targetPage);
                break;
              }
              case "closeTab": {
                const { pageId } = data as CloseTabEvent;
                await targetPage?.close();
                if (activePages.has(pageId)) {
                  activePages.delete(pageId);
                }
                break;
              }
              case "getSelectedText": {
                try {
                  const selectedText = await targetPage.evaluate(() => {
                    const focused = document.activeElement;
                    if (focused instanceof HTMLTextAreaElement
                        || (focused instanceof HTMLInputElement && focused.type !== "password")) {
                      return focused.value.slice(focused.selectionStart ?? 0, focused.selectionEnd ?? 0);
                    }
                    const selection = window.getSelection();
                    return selection ? selection.toString() : "";
                  });

                  // Send the selected text back to the client
                  ws.send(
                    JSON.stringify({
                      type: "selectedTextResponse",
                      pageId: (data as GetSelectedTextEvent).pageId,
                      text: selectedText,
                    }),
                  );
                } catch (error) {
                  console.error("Failed to get selected text:", error);
                  ws.send(
                    JSON.stringify({
                      type: "selectedTextResponse",
                      pageId: (data as GetSelectedTextEvent).pageId,
                      text: "",
                      error: error instanceof Error ? error.message : "Unknown error",
                    }),
                  );
                }
                break;
              }

              default:
                console.warn("Unknown event type:", type);
            }
            if (webchatInputId) ws.send(JSON.stringify({ type: "webchatInputApplied", requestId: webchatInputId, ok: true }));
          } catch (err) {
            if (webchatInputId) ws.send(JSON.stringify({ type: "webchatInputApplied", requestId: webchatInputId, ok: false }));
            console.error("Error handling WebSocket message:", err);
          }
        });

        // Apply metrics before capture, then install the frame listener before starting it.
        if (!webchatManaged) {
          await changeViewport(() => targetClient!.send("Page.setDeviceMetricsOverride", castMetrics(currentViewport)).then(() => {}));
        }

        // Handle screencast frames
        targetClient.on("Page.screencastFrame", async ({ data, sessionId, metadata }) => {
          try {
            // Acknowledge the frame right away to free up memory
            await targetClient?.send("Page.screencastFrameAck", { sessionId });

            // A second debugger can briefly expose Chrome's physical compositor
            // size while the page itself remains at the selected viewport.
            // Keep the last valid frame instead of displaying that wrong-sized cast.
            if (Math.abs(metadata.deviceWidth - currentViewport.width) > 2
                || Math.abs(metadata.deviceHeight - currentViewport.height) > 2) {
              return;
            }
            if (ws.readyState === WebSocket.OPEN) {
              // Metadata must never hold up frame delivery on a busy page.
              const title = targetInfo(targetPage!.target()).title;
              const favicon = lastFavicon;
              lastTitle = title;
              // Send frame data
              ws.send(
                JSON.stringify({
                  pageId: targetPageId,
                  url: targetPage?.url(),
                  title,
                  favicon,
                  data,
                  metadata,
                  editableRects,
                }),
              );
              lastFrameAt = Date.now();
            }
          } catch (err) {
            console.error("Error in Page.screencastFrame handler:", err);
          }
        });

        if (webchatManaged) editableScanInterval = setInterval(() => {
          if (editableScanPending || !targetPage || ws.readyState !== WebSocket.OPEN) return;
          editableScanPending = true;
          // Keep DOM inspection out of the screencast callback. A slow page
          // must never delay or freeze the visual stream.
          void scanEditableRects(targetPage).then((rects) => { editableRects = rects; }).catch(() => { editableRects = []; })
            .finally(() => { editableScanPending = false; });
        }, 250);

        if (webchatManaged) frameWatchdog = setInterval(() => {
          if (fallbackInFlight || !targetPage || !targetPageId
              || ws.readyState !== WebSocket.OPEN || Date.now() - lastFrameAt < 1500) return;
          fallbackInFlight = true;
          const viewport = { ...currentViewport };
          // Chromium pauses Page.screencastFrame for background tabs. A guarded
          // capture keeps each Webchat viewer current without stealing tab focus.
          void captureBackgroundPage(targetPageId).then((data) => {
            const dimensions = jpegDimensions(data);
            if (ws.readyState !== WebSocket.OPEN || !dimensions
                || dimensions.width !== viewport.width || dimensions.height !== viewport.height
                || viewport.width !== currentViewport.width || viewport.height !== currentViewport.height) return;
            ws.send(JSON.stringify({ pageId: targetPageId, url: targetPage?.url(), title: lastTitle,
              favicon: lastFavicon, data, editableRects,
              metadata: { timestamp: Date.now() / 1000,
                deviceWidth: viewport.width, deviceHeight: viewport.height } }));
            lastFrameAt = Date.now();
          }).catch((error) => console.error("Could not capture silent browser cast:", error))
            .finally(() => { fallbackInFlight = false; });
        }, 500);

        if (webchatManaged) ws.send(JSON.stringify({ type: "webchatCastReady", pageId: targetPageId }));
        await changeViewport(() => targetClient!.send("Page.startScreencast", castOptions(currentViewport)).then(() => {}));

        // Cleanup when target is destroyed
        browser.on("targetdestroyed", async (target) => {
          if (target.type() === "page") {
            try {
              //@ts-expect-error
              const pageId = target._targetId;

              if (pageId === targetPageId) {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: "targetClosed",
                      pageId: targetPageId,
                    }),
                  );
                }

                // Cleanup and close connection
                handleSessionCleanup();
                ws.close();
              }
            } catch (err) {
              console.error("Error handling destroyed target:", err);
            }
          }
        });

        // Setup heartbeat to detect dead connections
        heartbeatInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.ping();
            } catch (err) {
              console.error("Error sending ping:", err);
              handleSessionCleanup();
            }
          } else {
            handleSessionCleanup();
          }
        }, 30000);


      }
    } catch (err) {
      console.error("Error in cast session:", err);
      handleSessionCleanup();
      socket.destroy();
    }
  });
}
