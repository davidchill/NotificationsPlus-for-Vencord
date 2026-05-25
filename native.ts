/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 David Rodriguez and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, BrowserWindow, ipcMain, net, Notification as ElectronNotification, screen, shell } from "electron";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { writeFileSync } from "fs";
import { join } from "path";

import {
    DISCORD_SVG,
    GROUP_H,
    PRELOAD_SRC,
    TEMPLATE_HTML,
    TOAST_GAP,
    TOAST_MAX_H,
    TOAST_MIN_H,
    TOAST_W,
} from "./toastTemplate";

export interface DisplayInfo {
    index: number;
    label: string;
    bounds: { x: number; y: number; width: number; height: number; };
    primary: boolean;
}

export interface ToastOptions {
    title: string;
    body: string;
    icon: string;
    // Optional raw filesystem path to an avatar. When set and `icon` is empty,
    // showToastInternal reads + base64-encodes the file only AFTER the burst-skip
    // check passes, so dropped bursts don't pay the disk I/O.
    iconPath?: string;
    displayIndex: number;
    corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
    offsetX: number;
    offsetY: number;
    dmDisplayIndex: number;
    dmCorner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
    dmOffsetX: number;
    dmOffsetY: number;
    dmPersist: boolean;
    dmGroupThreshold: number;
    duration: number;
    font: string;
    titleSize: number;
    channelSize: number;
    bodySize: number;
    stackSize: number;
    entrance: "none" | "slide";
    gradientBg: boolean;
    bgOpacity: number;
    dmAccent: string;
    serverAccent: string;
    alwaysOnTop: boolean;
    // Per-channel debounce window (ms) for merging successive arrivals in the same
    // channel into a single toast. 0 disables coalescing. Clamped to [0, 2000] in
    // clampToastCaps. When >0, every native toast pays this much latency before
    // showing — the trade-off being that bursts collapse instead of churning.
    coalesceWindowMs: number;
    // Minimum pool size — the floor for warm BrowserWindows kept ready. Auto-scales
    // up via the stackSize + dmGroupThreshold + buffer formula, but never drops below
    // this. Lowering saves ~15-40 MB per dropped window at idle in exchange for one
    // cold create (~50-150 ms) on first toast after a quiet stretch. Clamped to
    // [1, POOL_MIN_MAX] in clampToastCaps. Mostly affects users with tight caps
    // (small stackSize+dmGroupThreshold) — for default caps the formula dominates.
    poolMin: number;
}

export type ToastConfig = Omit<ToastOptions, "title" | "body" | "icon"> & {
    titleTemplate: string;
    bodyTemplate: string;
    redirectOnClick: boolean;
    iconUrl: string;
};

// Google Fonts that need a <link> injection. System fonts (Arial, Segoe UI, etc.) are not listed here.
const GOOGLE_FONTS: Record<string, string> = {
    "Nunito": "Nunito:wght@400;500;600;700",
    "Inter": "Inter:wght@400;500;600;700",
    "Roboto": "Roboto:wght@400;500;700",
    "Poppins": "Poppins:wght@400;500;600;700",
    "Open Sans": "Open+Sans:wght@400;500;600;700",
    "Lato": "Lato:wght@400;700",
};

// ── Logging ──────────────────────────────────────────────────────────────────

// Off by default — flip via the renderer-side npDebug setting (Diagnostics panel).
// Output lands in the main-process console, which is visible when Discord is launched
// from a terminal (Windows: `start "" "C:\path\to\Discord.exe" --enable-logging`).
let debugEnabled = false;

export function setDebug(_: IpcMainInvokeEvent, enabled: boolean): void {
    debugEnabled = !!enabled;
}

// Info-level companion to logErr — used for opt-in performance diagnostics so we can
// actually measure burst-skip, coalescing, and pool behavior in the wild. Same dual
// output: main-process console + Discord renderer devtools. Gated on the same
// debugEnabled flag, so default users pay zero cost. Bare empty .catch on forwarding
// for the same reason as logErr: never recurse on a forwarding failure.
function logDiag(scope: string, msg: string): void {
    if (!debugEnabled) return;
    // eslint-disable-next-line no-console
    console.log(`[NotificationsPlus:${scope}]`, msg);
    if (senderWebContents && !senderWebContents.isDestroyed()) {
        const tag = JSON.stringify(`[NotificationsPlus:${scope}]`);
        const m = JSON.stringify(msg);
        senderWebContents.executeJavaScript(`console.log(${tag}, ${m})`).catch(() => {});
    }
}

function logErr(scope: string, err: unknown): void {
    if (!debugEnabled) return;
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack : "";

    // Main-process console — visible if Discord was launched from a terminal.
    // eslint-disable-next-line no-console
    console.warn(`[NotificationsPlus:${scope}]`, msg, stack ? `\n${stack}` : "");

    // Forward to Discord's renderer devtools (Ctrl+Shift+I → Console). This is the
    // practical way to see these on Windows where GUI apps don't reliably inherit
    // a parent terminal's stdout. Only fires when debug is on AND an error already
    // occurred, so the executeJavaScript cost (which #2 worked to minimize) is a
    // development-only expense, not a hot-path one. Bare empty catch — must NOT
    // call logErr recursively or a forwarding failure would loop infinitely.
    if (senderWebContents && !senderWebContents.isDestroyed()) {
        const tag = JSON.stringify(`[NotificationsPlus:${scope}]`);
        const m = JSON.stringify(msg);
        const s = JSON.stringify(stack);
        const args = stack ? `${tag}, ${m}, "\\n" + ${s}` : `${tag}, ${m}`;
        senderWebContents.executeJavaScript(`console.warn(${args})`).catch(() => {});
    }
}

// Use Electron's net module instead of node's http/https: it respects the user's
// system proxy, integrates with Chromium's network stack, and handles redirects
// automatically (default policy is "follow"). The previous implementation had no
// timeout, no abort signal, and no redirect cap — a hung Google Fonts response
// could stall ensureFontCached indefinitely on the first toast.
const FETCH_TIMEOUT_MS = 10_000;

function fetchBuffer(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const req = net.request({ url });
        req.setHeader(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0"
        );

        let settled = false;
        const finish = (err: Error | null, buf?: Buffer) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (err) reject(err);
            else resolve(buf!);
        };

        const timer = setTimeout(() => {
            try { req.abort(); } catch { /* already finished */ }
            finish(new Error(`fetchBuffer: timeout after ${FETCH_TIMEOUT_MS}ms for ${url}`));
        }, FETCH_TIMEOUT_MS);

        req.on("response", response => {
            const status = response.statusCode;
            if (status < 200 || status >= 400) {
                try { req.abort(); } catch { /* already finished */ }
                finish(new Error(`fetchBuffer: HTTP ${status} for ${url}`));
                return;
            }
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () => finish(null, Buffer.concat(chunks)));
            response.on("error", (err: Error) => finish(err));
        });

        req.on("error", (err: Error) => finish(err));
        req.on("abort", () => finish(new Error(`fetchBuffer: aborted for ${url}`)));

        req.end();
    });
}

const fontCache = new Map<string, string>();

async function ensureFontCached(fontName: string): Promise<void> {
    if (fontCache.has(fontName)) return;
    const query = GOOGLE_FONTS[fontName];
    if (!query) return;
    try {
        const cssBuf = await fetchBuffer(`https://fonts.googleapis.com/css2?family=${query}&display=swap`);
        let css = cssBuf.toString("utf-8");
        const urls = [...css.matchAll(/url\((https:\/\/[^)]+)\)/g)].map(m => m[1]);
        const fontBufs = await Promise.all(urls.map(u => fetchBuffer(u)));
        for (let i = 0; i < urls.length; i++) {
            const fontUrl = urls[i];
            const ext = fontUrl.split(".").pop()?.split("?")[0] ?? "woff2";
            const mime = ext === "woff2" ? "font/woff2" : ext === "woff" ? "font/woff" : "font/ttf";
            css = css.replace(fontUrl, `data:${mime};base64,${fontBufs[i].toString("base64")}`);
        }
        fontCache.set(fontName, css);
    } catch (err) {
        // Network error — toast falls back to system font. Logged so the user can see
        // why their chosen Google font isn't applying.
        logErr(`font-cache:${fontName}`, err);
    }
}

// Defensive: accent settings are now constrained by the renderer-side ColorPicker,
// but legacy values, settings imports, or the iconUrl-override flow could still
// deliver a malformed hex. Fall back to Discord brand purple instead of black
// (parseInt("xyz",16) → NaN; NaN bitwise-shifted becomes 0 → black border).
function hexToRgb(hex: string): [number, number, number] {
    let s = (hex || "").trim().replace(/^#/, "");
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return [88, 101, 242];
    const n = parseInt(s, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function darkenHex(hex: string, factor = 0.78): string {
    const [r, g, b] = hexToRgb(hex);
    const d = (c: number) => Math.round(c * factor).toString(16).padStart(2, "0");
    return `#${d(r)}${d(g)}${d(b)}`;
}

function escapeHtml(s: string) {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function formatBody(text: string): string {
    return escapeHtml(text).replace(
        /(https?:\/\/[^\s]+)|(@\S+)/g,
        (_, url, mention) => url
            ? `<span class="link">${url}</span>`
            : `<span class="mention">${mention}</span>`
    );
}

const TEMPLATE_B64 = Buffer.from(TEMPLATE_HTML).toString("base64");

// Parses "Username (#channel, Category)" title format and computes all per-toast dynamic values.
// Same title-parsing logic as the old buildHtml — extracted for reuse with the template approach.
interface UpdateData {
    ar: number; ag: number; ab: number;
    ts: number; cs: number; bs: number; bmax: number;
    sf: string; font: string; fc: string;
    grad: boolean; bgD: string; bgL: string; bhD: string; bhL: string;
    icon: string; title: string; isDM: boolean; cat: string; ch: string;
    bhtml: string; lnk: string | null;
    barMs: number; ent: string; clk: boolean;
}

function buildUpdateData(
    options: ToastOptions,
    effectiveDuration: number,
    clickable: boolean,
    isRight: boolean,
    fontCss: string
): UpdateData {
    const { body, icon, font, titleSize, channelSize, bodySize, entrance, gradientBg, bgOpacity, dmAccent, serverAccent } = options;

    // Discord notification title format: "Username (#channel-name, Category)"
    // Category names may contain nested parentheses (e.g. "Community (Non-GTA)") — use paren balancing.
    const raw = options.title.trim();
    let displayName = raw, categoryDisplay = "", channelDisplay = "";
    const ctxIdx = raw.search(/\s+\(#/);
    if (ctxIdx !== -1) {
        const openIdx = raw.indexOf("(", ctxIdx);
        let depth = 0, closeIdx = -1;
        for (let i = openIdx; i < raw.length; i++) {
            if (raw[i] === "(") depth++;
            else if (raw[i] === ")") { if (--depth === 0) { closeIdx = i; break; } }
        }
        if (closeIdx !== -1) {
            const inner = raw.slice(openIdx + 1, closeIdx);
            const commaIdx = inner.indexOf(",");
            if (commaIdx !== -1) {
                channelDisplay = inner.slice(0, commaIdx).trim();
                categoryDisplay = inner.slice(commaIdx + 1).trim();
            } else {
                channelDisplay = inner.trim();
            }
            displayName = raw.slice(0, ctxIdx).trim();
        }
    }
    const isDM = !channelDisplay && !categoryDisplay;
    const accent = isDM ? dmAccent : serverAccent;
    const [ar, ag, ab] = hexToRgb(accent);

    const firstUrlMatch = body.match(/https?:\/\/[^\s]+/);
    const firstUrl = firstUrlMatch ? firstUrlMatch[0] : null;
    const lnk = firstUrl ? `vc-np://open-link/${encodeURIComponent(firstUrl)}` : null;

    const op = gradientBg ? (Math.max(0, Math.min(100, bgOpacity)) / 100).toFixed(2) : "1";
    const hoverOp = gradientBg ? Math.min(1, Number(op) + 0.06).toFixed(2) : "1";
    const bgD = gradientBg ? `linear-gradient(135deg,rgba(30,31,36,${op}) 0%,rgba(36,38,46,${op}) 100%)` : "#232428";
    const bgL = gradientBg ? `linear-gradient(135deg,rgba(252,252,255,${op}) 0%,rgba(242,243,248,${op}) 100%)` : "#ffffff";
    const bhD = gradientBg ? `rgba(44,46,52,${hoverOp})` : "#2a2c31";
    const bhL = gradientBg ? `rgba(237,238,242,${hoverOp})` : "#f2f3f5";

    return {
        ar, ag, ab,
        ts: titleSize, cs: channelSize, bs: bodySize,
        bmax: Math.ceil(bodySize * 1.4 * 3),
        sf: isRight ? "calc(100% + 20px)" : "calc(-100% - 20px)",
        font, fc: fontCss,
        grad: gradientBg, bgD, bgL, bhD, bhL,
        icon: icon || "",
        title: displayName, isDM,
        cat: categoryDisplay, ch: channelDisplay,
        bhtml: formatBody(body),
        lnk, barMs: effectiveDuration * 1000,
        ent: entrance, clk: clickable,
    };
}

// ── Displays & toast window ──────────────────────────────────────────────────

// Stored when startMainProcessPatch is called so we can run executeJavaScript
// on the Discord renderer for jump-to-message after a toast click.
let senderWebContents: WebContents | null = null;

// Extracts the guild/channel/message IDs Discord encodes in the toastXml
// <toast launch="..."> attribute (Windows). Tries both the discord:// URL form
// and bare space-separated IDs, and handles DM channels (@me).
function extractNavData(notif: any): { channelId: string; messageId: string; } | null {
    const xml = (notif.toastXml as string) ?? "";
    const tag = (notif.tag as string) ?? "";
    const launchMatch = xml.match(/\blaunch=["']([^"']*)["']/i);
    const launch = launchMatch ? launchMatch[1] : "";
    for (const src of [launch, tag]) {
        if (!src) continue;
        // discord://discord.com/channels/@me/CHANNEL_ID/MESSAGE_ID  or  .../GUILD/CHANNEL/MESSAGE
        const m = src.match(/channels\/(?:@me|\d+)\/(\d+)\/(\d+)/);
        if (m) return { channelId: m[1], messageId: m[2] };
        // Bare space/comma separated: "GUILD_ID CHANNEL_ID MESSAGE_ID"
        const parts = src.split(/[\s,]+/).filter(p => /^\d{10,}$/.test(p));
        if (parts.length >= 3) return { channelId: parts[1], messageId: parts[2] };
        if (parts.length === 2) return { channelId: parts[0], messageId: parts[1] };
    }
    // Last resort: custom properties Discord may attach directly to the notif object
    if (notif.channelId && notif.messageId) {
        return { channelId: String(notif.channelId), messageId: String(notif.messageId) };
    }
    return null;
}

// Fallback coalesce key when extractNavData returns null (e.g. Discord build doesn't
// emit `launch=` in toastXml). Derived from the notification title using the same
// "Username (#channel, Category)" parser as buildUpdateData. For server messages we
// key on the channel context so multiple senders in the same channel coalesce; for
// DMs we key on the sender username so each conversation coalesces independently.
// Returns null if the title is empty or unparseable.
function deriveFallbackCoalesceKey(title: string): string | null {
    const raw = title.trim();
    if (!raw) return null;
    const ctxIdx = raw.search(/\s+\(#/);
    if (ctxIdx === -1) {
        // No (# context — treat as DM. Key by sender username.
        return `dm:${raw}`;
    }
    // Server — extract (#channel, Category) substring as key, using the same
    // balanced-paren walk as the title parser (category names may contain parens).
    const openIdx = raw.indexOf("(", ctxIdx);
    let depth = 0;
    let closeIdx = -1;
    for (let i = openIdx; i < raw.length; i++) {
        if (raw[i] === "(") depth++;
        else if (raw[i] === ")") { if (--depth === 0) { closeIdx = i; break; } }
    }
    if (closeIdx === -1) return null;
    return `srv:${raw.slice(openIdx + 1, closeIdx)}`;
}

export function getDisplays(_: IpcMainInvokeEvent): DisplayInfo[] {
    const primary = screen.getPrimaryDisplay();
    return screen.getAllDisplays().map((d, i) => ({
        index: i,
        label: d.label || `Display ${i + 1}`,
        bounds: d.bounds,
        primary: d.id === primary.id,
    }));
}

function buildGroupHtml(count: number, isDM: boolean, font: string, channelSize: number): string {
    const accent = isDM ? "#23a55a" : "#5865f2";
    const border = isDM ? "rgba(35,165,90,.35)" : "rgba(88,101,242,.35)";
    const hover  = isDM ? "rgba(35,165,90,.12)" : "rgba(88,101,242,.12)";
    const plural = count !== 1 ? "s" : "";
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:${GROUP_H}px;background:transparent;overflow:hidden}
body{font-family:"${font}","Segoe UI",-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
.g{background:#2b2d31;border-radius:10px;border-left:4px solid ${accent};padding:0 14px 0 12px;display:flex;align-items:center;gap:10px;width:100%;height:${GROUP_H}px;box-shadow:0 8px 24px rgba(0,0,0,.5),0 0 0 1px ${border};cursor:pointer;user-select:none}
.g:hover{background:#32353b}
.dot{width:8px;height:8px;border-radius:50%;background:${accent};flex-shrink:0}
.lbl{font-size:${channelSize}px;font-weight:600;color:${accent}}
@media(prefers-color-scheme:light){.g{background:#fff}.g:hover{background:#f2f3f5;}}
</style></head><body>
<div class="g" onclick="window.close()" oncontextmenu="window.close()">
  <div class="dot"></div>
  <div class="lbl" id="lbl">${count} earlier message${plural}</div>
</div>
</body></html>`;
}

function updateGroupLabel(entry: StackEntry, count: number): void {
    if (entry.win.isDestroyed()) return;
    const plural = count !== 1 ? "s" : "";
    entry.win.webContents.executeJavaScript(
        `var e=document.getElementById('lbl');if(e)e.textContent='${count} earlier message${plural}';`
    ).catch(err => logErr("group-label-update", err));
}

async function createGroupWindow(
    toastKey: string,
    count: number,
    isDM: boolean,
    font: string,
    channelSize: number,
    bounds: { x: number; y: number; width: number; height: number },
    isBottom: boolean,
    isRight: boolean,
    offsetX: number,
    offsetY: number,
    alwaysOnTop: boolean
): Promise<void> {
    const stack = toastStacks.get(toastKey)!;
    const groupWin = new BrowserWindow({
        x: 0, y: 0, width: TOAST_W, height: GROUP_H,
        show: false, frame: false, alwaysOnTop, transparent: true,
        skipTaskbar: true, resizable: false, movable: false, focusable: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const groupEntry: StackEntry = { win: groupWin, h: GROUP_H, isGroup: true, addedAt: Date.now() };
    stack.push(groupEntry);

    groupWin.on("closed", () => {
        pendingMoves.delete(groupWin);
        const s = toastStacks.get(toastKey);
        if (s) {
            const i = s.findIndex(e => e.win === groupWin);
            if (i !== -1) s.splice(i, 1);
            if (s.length === 0) {
                toastStacks.delete(toastKey);
                evictedCounts.delete(toastKey);
            } else {
                evictedCounts.set(toastKey, 0);
            }
        }
        scheduleReposition(toastKey, bounds, isBottom, isRight, offsetX, offsetY);
    });

    const html = buildGroupHtml(count, isDM, font, channelSize);
    await groupWin.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
    repositionStack(toastKey, bounds, isBottom, isRight, offsetX, offsetY);
    if (!groupWin.isDestroyed()) {
        if (alwaysOnTop) { groupWin.show(); } else { groupWin.showInactive(); }
    }
}

// True when the notification title has no Discord channel context "(#channel, Category)".
// Used to select DM-specific positioning before building the window.
function isDMTitle(title: string): boolean {
    return title.trim().search(/\s+\(#/) === -1;
}

async function showToastInternal(options: ToastOptions, onClicked?: () => void): Promise<number> {
    const t0 = performance.now();
    const isDM = isDMTitle(options.title);
    const corner = isDM ? options.dmCorner : options.corner;
    const displayIndex = isDM ? options.dmDisplayIndex : options.displayIndex;
    const offsetX = isDM ? options.dmOffsetX : options.offsetX;
    const offsetY = isDM ? options.dmOffsetY : options.offsetY;

    const toastKey = `${displayIndex}-${corner}`;
    if (!toastStacks.has(toastKey)) toastStacks.set(toastKey, []);
    const stack = toastStacks.get(toastKey)!;

    // DMs use their own stack cap (group threshold); server messages use stackSize.
    // Values are clamped once at the config/IPC boundary (clampToastCaps), so we read
    // them directly here without re-clamping per toast.
    const maxStack = isDM ? options.dmGroupThreshold : options.stackSize;

    // ── Burst-skip ───────────────────────────────────────────────────────────
    // If the stack is already at cap and the oldest visible toast is still fresh
    // (within BURST_THRESHOLD_MS), we're in a message burst — e.g. notifications=All
    // on an active server. Creating a new toast here would just evict an existing
    // one before the user could read it, burning a BrowserWindow create, IPC update,
    // and DWM compositor cycle for ~100 ms of visibility. Skip the new toast; for
    // DMs we feed the group counter so the "N earlier messages" count stays accurate.
    const fullCountAtArrival = stack.reduce((n, e) => n + (e.isGroup ? 0 : 1), 0);
    if (fullCountAtArrival >= maxStack) {
        let oldestAddedAt = Infinity;
        for (const e of stack) {
            if (!e.isGroup && e.addedAt < oldestAddedAt) oldestAddedAt = e.addedAt;
        }
        if (Date.now() - oldestAddedAt < BURST_THRESHOLD_MS) {
            logDiag("burst-skip", `key=${toastKey} isDM=${isDM} oldestAgeMs=${Math.round(Date.now() - oldestAddedAt)} stackFull=${fullCountAtArrival}/${maxStack}`);
            if (isDM) {
                const newCount = (evictedCounts.get(toastKey) ?? 0) + 1;
                evictedCounts.set(toastKey, newCount);
                const display = screen.getAllDisplays()[displayIndex] ?? screen.getPrimaryDisplay();
                const dBounds = display.bounds;
                const dIsRight = corner.endsWith("right");
                const dIsBottom = corner.startsWith("bottom");
                const existingGroup = stack.find(e => e.isGroup);
                if (existingGroup) {
                    updateGroupLabel(existingGroup, newCount);
                } else {
                    await createGroupWindow(toastKey, newCount, true, options.font, options.channelSize, dBounds, dIsBottom, dIsRight, offsetX, offsetY, options.alwaysOnTop ?? true);
                }
            }
            return -1;
        }
    }

    // Evict the oldest full (non-group) toast(s) to make room.
    // For DMs, evicted toasts feed a group summary window instead of being silently dropped.
    let fullCount = fullCountAtArrival;
    while (fullCount >= maxStack) {
        let oldestIdx = -1;
        for (let i = stack.length - 1; i >= 0; i--) {
            if (!stack[i].isGroup) { oldestIdx = i; break; }
        }
        if (oldestIdx === -1) break;
        const oldest = stack[oldestIdx];
        stack.splice(oldestIdx, 1);
        if (!oldest.win.isDestroyed()) oldest.win.close();
        fullCount--;
        logDiag("evict", `key=${toastKey} isDM=${isDM} ageMs=${Math.round(Date.now() - oldest.addedAt)}`);

        if (isDM) {
            const newCount = (evictedCounts.get(toastKey) ?? 0) + 1;
            evictedCounts.set(toastKey, newCount);
        }
    }

    const displays = screen.getAllDisplays();
    const display = displays[displayIndex] ?? screen.getPrimaryDisplay();
    const { bounds } = display;
    const isRight = corner.endsWith("right");
    const isBottom = corner.startsWith("bottom");

    // DMs with persist enabled never auto-close (duration 0 = no timer bar, no timeout).
    const effectiveDuration = isDM && options.dmPersist ? 0 : options.duration;

    // Sync group summary window now that eviction is done.
    if (isDM) {
        const evicted = evictedCounts.get(toastKey) ?? 0;
        const existingGroup = stack.find(e => e.isGroup);
        if (evicted > 0) {
            if (existingGroup) {
                updateGroupLabel(existingGroup, evicted);
            } else {
                await createGroupWindow(toastKey, evicted, isDM, options.font, options.channelSize, bounds, isBottom, isRight, offsetX, offsetY, options.alwaysOnTop ?? true);
            }
        }
    }

    // Pool windows pre-load the template HTML, so acquireWindow resolves almost instantly
    // when the pool is warm. executeJavaScript then updates content in ~5-20ms vs the
    // previous loadURL approach which took 50-150ms per notification.
    //
    // Resolve the avatar in parallel with the window acquire: both touch independent
    // resources (disk vs pool) and used to run back-to-back. The icon-read is also
    // deferred until *after* the burst-skip check above, so dropped bursts pay no I/O.
    const iconPromise = (!options.icon && options.iconPath)
        ? iconPathToDataUrl(options.iconPath)
        : Promise.resolve(options.icon);
    const [resolvedIcon, win] = await Promise.all([iconPromise, acquireWindow()]);
    const tAcquire = performance.now();

    const entry: StackEntry = { win, h: TOAST_MIN_H, isGroup: false, addedAt: Date.now() };
    stack.unshift(entry);

    win.on("closed", () => {
        pendingMoves.delete(win);
        const s = toastStacks.get(toastKey);
        if (s) {
            const idx = s.findIndex(e => e.win === win);
            if (idx !== -1) s.splice(idx, 1);
            if (s.length === 0) {
                toastStacks.delete(toastKey);
                evictedCounts.delete(toastKey);
            }
        }
        scheduleReposition(toastKey, bounds, isBottom, isRight, offsetX, offsetY);
    });

    const fontCss = fontCache.get(options.font) ?? "";
    // Lazy-fire font fetch for next time; ensureFontCached itself already logs errors.
    if (!fontCss && GOOGLE_FONTS[options.font]) ensureFontCached(options.font).catch(() => {});

    const updateData = buildUpdateData({ ...options, icon: resolvedIcon }, effectiveDuration, !!onClicked, isRight, fontCss);

    // sendToastUpdate combines content update and height measurement into a single
    // round-trip. Uses preload IPC when available (faster, structured clone), falls
    // back to executeJavaScript otherwise. Height is measured after forced layout.
    const contentH = await sendToastUpdate(win, updateData);
    const tUpdate = performance.now();
    const measuredH = Math.max(TOAST_MIN_H, Math.min(contentH, TOAST_MAX_H));

    entry.h = measuredH;
    if (!win.isDestroyed()) {
        // Position the NEW toast at its exact slot immediately so it appears at the
        // correct position with no post-show correction jump. Since unshift puts it at
        // stack[0] (topmost), its position is the corner anchor itself — no preceding
        // heights to sum, so we can compute it without iterating the stack.
        //
        // The shifts of *existing* toasts (to make room) are deferred to scheduleReposition
        // so concurrent arrivals in the same tick coalesce into a single full-stack pass.
        // animateWindowTo on the not-yet-visible new window uses setBounds-immediate
        // (no animation), matching the previous synchronous-reposition behavior for it.
        const aot = options.alwaysOnTop ?? true;
        win.setAlwaysOnTop(aot);
        const newX = Math.round(isRight ? bounds.x + bounds.width - TOAST_W - offsetX : bounds.x + offsetX);
        const newY = Math.round(isBottom
            ? bounds.y + bounds.height - measuredH - offsetY
            : bounds.y + offsetY);
        animateWindowTo(win, newX, newY, TOAST_W, measuredH);
        scheduleReposition(toastKey, bounds, isBottom, isRight, offsetX, offsetY);
        // When alwaysOnTop is off, use showInactive() (SW_SHOWNA on Windows) so the
        // toast is rendered without activating it — the currently active window stays
        // in front rather than the toast popping over it.
        if (aot) {
            win.show();
        } else {
            win.showInactive();
        }
    }

    // Handle all vc-np:// navigations: toast click and "Open Link" button.
    win.webContents.on("will-navigate", (event, url) => {
        if (!url.startsWith("vc-np://")) return;
        event.preventDefault();
        if (url.startsWith("vc-np://click")) {
            if (!win.isDestroyed()) win.close();
            onClicked?.();
        } else if (url.startsWith("vc-np://open-link/")) {
            if (!win.isDestroyed()) win.close();
            try {
                const targetUrl = decodeURIComponent(url.slice("vc-np://open-link/".length));
                shell.openExternal(targetUrl);
            } catch (err) {
                logErr("open-link", err);
            }
        }
    });

    if (effectiveDuration > 0) {
        setTimeout(() => {
            closeWithAnimation(win);
        }, effectiveDuration * 1000);
    }

    const tEnd = performance.now();
    logDiag("toast.show",
        `key=${toastKey} isDM=${isDM} acquire=${(tAcquire - t0).toFixed(1)}ms ` +
        `update=${(tUpdate - tAcquire).toFixed(1)}ms ` +
        `tail=${(tEnd - tUpdate).toFixed(1)}ms total=${(tEnd - t0).toFixed(1)}ms ` +
        `measuredH=${measuredH}`);

    return win.id;
}

// Clamp stack/group caps once at the boundary so showToastInternal can trust them.
// Mutates in place — both ToastOptions and ToastConfig carry the same fields.
function clampToastCaps(o: { stackSize: number; dmGroupThreshold: number; coalesceWindowMs?: number; poolMin?: number; }): void {
    o.stackSize = Math.max(1, Math.min(5, o.stackSize ?? 3));
    o.dmGroupThreshold = Math.max(2, o.dmGroupThreshold ?? 5);
    o.coalesceWindowMs = Math.max(0, Math.min(2000, o.coalesceWindowMs ?? 200));
    o.poolMin = Math.max(1, Math.min(POOL_MIN_MAX, o.poolMin ?? POOL_MIN_DEFAULT));
}

// IPC-callable version — renderer cannot pass function callbacks
export async function showToast(_: IpcMainInvokeEvent, options: ToastOptions): Promise<number> {
    clampToastCaps(options);
    return showToastInternal(options);
}

// ── Main-process Notification interception ───────────────────────────────────

function unescapeXml(s: string) {
    return s
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&apos;/g, "'");
}

// Discord wraps every text segment in Unicode bidi control characters (U+2068 FSI / U+2069 PDI)
// for RTL/LTR handling. Strip them so "#channel" comparisons work correctly.
function stripBidi(s: string): string {
    let out = "";
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if ((c >= 0x200B && c <= 0x200F) || (c >= 0x2028 && c <= 0x202E) || (c >= 0x2060 && c <= 0x2069) || c === 0xFEFF) continue;
        out += s[i];
    }
    return out;
}

// Discord on Windows uses toastXml for rich notifications, leaving title/body empty.
// Extract visible text from <text> elements as a fallback.
function extractFromToastXml(xml: string): { title: string; body: string; } {
    const texts = [...xml.matchAll(/<text[^>]*>([^<]*)<\/text>/gi)]
        .map(m => stripBidi(unescapeXml(m[1].trim())))
        .filter(Boolean);
    return { title: texts[0] ?? "", body: texts.slice(1).join(" ") };
}

// Extract the avatar/icon path from the appLogoOverride image element in toastXml.
// Discord uses single-quoted attributes, so the regex accepts both quote styles.
function extractImageFromToastXml(xml: string): string {
    const match = xml.match(/<image[^>]+src=['"]([^'"]+)['"]/i);
    return match ? match[1] : "";
}

// Discord saves the avatar as a temp PNG before firing the notification.
// A sandboxed BrowserWindow can't load a bare file path from a data: page,
// so we read it immediately and return a base64 data URI instead.
const ICON_CACHE_MAX = 50;
const iconCache = new Map<string, string>();

async function iconPathToDataUrl(src: string): Promise<string> {
    if (!src) return "";
    if (src.startsWith("data:") || src.startsWith("http://") || src.startsWith("https://")) return src;
    // True LRU: delete + re-set on hit so the most-recently-used entry sits at the
    // tail of Map's insertion order, and eviction below removes the actual oldest use.
    const cached = iconCache.get(src);
    if (cached !== undefined) {
        iconCache.delete(src);
        iconCache.set(src, cached);
        return cached;
    }
    try {
        const { readFile } = require("fs/promises") as typeof import("fs/promises");
        const buf = await readFile(src);
        const ext = src.split(".").pop()?.toLowerCase() ?? "png";
        const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
        const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
        if (iconCache.size >= ICON_CACHE_MAX) iconCache.delete(iconCache.keys().next().value!);
        iconCache.set(src, dataUrl);
        return dataUrl;
    } catch {
        return "";
    }
}

// Tracks the visible toast stack per display+corner. Keyed by "${displayIndex}-${corner}".
// Index 0 = newest (closest to corner), last index = oldest.
// Group entry (isGroup: true) is always last when present.
interface StackEntry { win: BrowserWindow; h: number; isGroup: boolean; addedAt: number; }

// Burst-skip window: if the oldest visible toast in the stack is younger than this
// AND the stack is at cap, a new arrival is dropped (or fed to the DM group counter)
// instead of churning the window pool. 500 ms matches the perceptual threshold where
// a toast would be evicted before the user could realistically read it.
const BURST_THRESHOLD_MS = 500;
const toastStacks = new Map<string, StackEntry[]>();
// Count of DM toasts evicted from the visible stack without being dismissed by the user.
// When > 0 a compact group summary window is shown at the bottom of that stack.
const evictedCounts = new Map<string, number>();

let preloadPath: string | null = null;
let preloadInitTried = false;

// Writes the preload to a temp file once per session. Uses temp (not userData) so
// stale code from old plugin versions is cleared on each launch automatically.
// Returns null if the write failed — callers must fall back to executeJavaScript.
function ensurePreload(): string | null {
    if (preloadInitTried) return preloadPath;
    preloadInitTried = true;
    try {
        const p = join(app.getPath("temp"), "notificationsPlus-toast-preload.js");
        writeFileSync(p, PRELOAD_SRC, "utf8");
        preloadPath = p;
    } catch {
        preloadPath = null;
    }
    return preloadPath;
}

// Default minimum pool size when no config is available yet — also the default value
// for the user-configurable `poolMin` setting. Keeps the first toast after plugin load
// from paying the cold-create cost.
const POOL_MIN_DEFAULT = 4;
// Upper bound on the user-configurable poolMin. Beyond this, idle RAM cost outpaces
// the cold-create savings even on heavy-burst usage patterns.
const POOL_MIN_MAX = 8;
// Hard upper bound on total pool size regardless of formula or settings. Bumped from
// 12 to 16 so users with the maximum stackSize (5) + a moderate dmGroupThreshold (10)
// still get the full computed headroom instead of being clipped.
const POOL_MAX = 16;
// Buffer added on top of (stackSize + dmGroupThreshold) so the pool has a small
// surplus beyond worst-case concurrent active windows — absorbs short overshoots
// during arrivals that overlap with not-yet-closed eviction targets.
const POOL_BUFFER = 2;
const windowPool: BrowserWindow[] = [];

// Auto-size the pool to (stackSize + dmGroupThreshold + POOL_BUFFER) so worst-case
// concurrent server + DM activity has buffers ready. Falls back to the user's poolMin
// (or POOL_MIN_DEFAULT pre-handshake) when no config is known yet. Final value is
// clamped to [poolMin, POOL_MAX] so individual users can shift the floor without
// blowing past the hard ceiling.
function targetPoolSize(): number {
    const cfg = mainToastConfig;
    const min = cfg?.poolMin ?? POOL_MIN_DEFAULT;
    if (!cfg) return min;
    const headroom = cfg.stackSize + cfg.dmGroupThreshold + POOL_BUFFER;
    return Math.max(min, Math.min(POOL_MAX, headroom));
}

// Tracks when each pool window has finished loading the template HTML.
// acquireWindow awaits this before handing the window to showToastInternal,
// ensuring executeJavaScript can run immediately without page-ready races.
const poolReady = new WeakMap<BrowserWindow, Promise<void>>();

function createPoolWindow(): BrowserWindow {
    const preload = ensurePreload();
    const webPreferences: Electron.WebPreferences = {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
    };
    if (preload) webPreferences.preload = preload;
    const w = new BrowserWindow({
        width: TOAST_W,
        height: TOAST_MIN_H,
        show: false,
        frame: false,
        alwaysOnTop: true,
        transparent: true,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        focusable: false,
        webPreferences,
    });
    poolReady.set(w, w.loadURL(`data:text/html;base64,${TEMPLATE_B64}`));
    return w;
}

function warmPool(): void {
    const target = targetPoolSize();
    while (windowPool.length < target) {
        windowPool.push(createPoolWindow());
    }
}

async function acquireWindow(): Promise<BrowserWindow> {
    while (windowPool.length > 0) {
        const w = windowPool.pop()!;
        if (!w.isDestroyed()) {
            // Synchronous refill — replaces the previous `process.nextTick(warmPool)`.
            // Under burst, multiple acquireWindow calls run interleaved at their await
            // points; with deferred refill, several could see an empty pool before any
            // nextTick fires. Synchronous refill guarantees the pool array is back to
            // target before this acquire's await yields. warmPool is idempotent (no-op
            // when already at target), so the only added cost is `new BrowserWindow()`
            // for as many slots as were consumed since the last warmPool — typically 1.
            //
            // Note: the just-created windows are added immediately, but their loadURL
            // is still pending. A subsequent acquireWindow popping one of them will
            // still pay the cold loadURL cost (~50-150 ms) on its `await poolReady.get`.
            // This is unavoidable without pre-creating the windows much earlier; what
            // sync refill DOES fix is the "pool empty so we go MISS path and create yet
            // another window we already had" double-create scenario.
            warmPool();
            await poolReady.get(w);
            return w;
        }
    }
    // Pool MISS — pool was truly empty (e.g. every entry's window had been destroyed).
    // Pay the cold create+loadURL cost on the hot path. If this fires often in
    // diagnostics, the user may want to raise `Pool minimum size` so the floor exceeds
    // their typical burst length.
    logDiag("pool", `MISS — cold-create (target=${targetPoolSize()})`);
    warmPool();
    const w = createPoolWindow();
    await poolReady.get(w);
    return w;
}

function drainPool(): void {
    for (const w of windowPool) {
        if (!w.isDestroyed()) w.close();
    }
    windowPool.length = 0;
}

// Monotonic counter for unique reply channel names — two toasts on the same pool
// window in the same millisecond would otherwise collide on Date.now() alone.
let replySeq = 0;

// Push toast content to a pool window. Prefers IPC (preload) which uses Electron's
// structured clone — avoids the V8 parse+eval cost of executeJavaScript and is type-safe
// across the boundary. Falls back to executeJavaScript if the preload write failed at startup.
// Returns the measured scrollHeight so callers can size the window before showing.
async function sendToastUpdate(win: BrowserWindow, data: UpdateData): Promise<number> {
    if (preloadPath) {
        const replyCh = `np:measured-${win.webContents.id}-${++replySeq}`;
        return new Promise<number>(resolve => {
            // Safety net: if the renderer dies before replying we'd leak the listener
            // and stall the show path forever. 2 s is well above expected ~5–20 ms.
            const timeout = setTimeout(() => {
                ipcMain.removeAllListeners(replyCh);
                resolve(TOAST_MIN_H);
            }, 2000);
            ipcMain.once(replyCh, (_e, h: number) => {
                clearTimeout(timeout);
                resolve(typeof h === "number" && h > 0 ? h : TOAST_MIN_H);
            });
            try {
                win.webContents.send("np:update", { ...data, _reply: replyCh });
            } catch {
                clearTimeout(timeout);
                ipcMain.removeAllListeners(replyCh);
                resolve(TOAST_MIN_H);
            }
        });
    }
    try {
        const h: number = await win.webContents.executeJavaScript(
            `window.__npUpdate(${JSON.stringify(data)})`
        );
        return typeof h === "number" && h > 0 ? h : TOAST_MIN_H;
    } catch {
        return TOAST_MIN_H;
    }
}

// Shared animation ticker — one global setInterval drives every in-flight window move
// instead of each animateWindowTo spinning up its own timer. With multiple toasts moving
// at once (e.g. one closes while another arrives) this collapses N timers + N setBounds
// per frame into one. The ticker auto-stops when the queue empties and restarts when
// the next move is registered, so there's no idle cost.
interface MoveSpec {
    startX: number; startY: number;
    targetX: number; targetY: number;
    width: number; height: number;
    startTime: number;
}
const pendingMoves = new Map<BrowserWindow, MoveSpec>();
const ANIM_DURATION_MS = 120;
const ANIM_TICK_MS = 16;
let animTicker: ReturnType<typeof setInterval> | null = null;

function tickAnimations() {
    if (pendingMoves.size === 0) {
        if (animTicker !== null) { clearInterval(animTicker); animTicker = null; }
        return;
    }
    const now = Date.now();
    for (const [win, m] of pendingMoves) {
        if (win.isDestroyed()) { pendingMoves.delete(win); continue; }
        const t = Math.min(1, (now - m.startTime) / ANIM_DURATION_MS);
        const ease = 1 - Math.pow(1 - t, 3);
        win.setBounds({
            x: Math.round(m.startX + (m.targetX - m.startX) * ease),
            y: Math.round(m.startY + (m.targetY - m.startY) * ease),
            width: m.width,
            height: m.height,
        });
        if (t >= 1) pendingMoves.delete(win);
    }
    if (pendingMoves.size === 0 && animTicker !== null) {
        clearInterval(animTicker); animTicker = null;
    }
}

function animateWindowTo(win: BrowserWindow, x: number, y: number, w: number, h: number) {
    // A pending move for this window gets replaced (not queued) — the latest target wins,
    // matching the previous behavior where each call cleared the in-flight interval.
    pendingMoves.delete(win);

    if (!win.isVisible()) {
        win.setBounds({ x, y, width: w, height: h });
        return;
    }

    const start = win.getBounds();
    if (start.x === x && start.y === y && start.width === w && start.height === h) return;

    // Sub-pixel moves snap — animation would be visually identical and wastes ticks.
    if (Math.abs(x - start.x) <= 3 && Math.abs(y - start.y) <= 3 && start.width === w && start.height === h) {
        win.setBounds({ x, y, width: w, height: h });
        return;
    }

    pendingMoves.set(win, {
        startX: start.x, startY: start.y,
        targetX: x, targetY: y,
        width: w, height: h,
        startTime: Date.now(),
    });
    if (animTicker === null) animTicker = setInterval(tickAnimations, ANIM_TICK_MS);
}

function closeWithAnimation(win: BrowserWindow, delayMs = 150) {
    if (win.isDestroyed()) return;
    if (preloadPath) {
        try { win.webContents.send("np:close-animate"); } catch (err) { logErr("close-animate:send", err); }
    } else {
        win.webContents.executeJavaScript(
            "var t=document.querySelector('.toast');if(t)t.classList.add('timeout-exit')"
        ).catch(err => logErr("close-animate:exec", err));
    }
    setTimeout(() => { if (!win.isDestroyed()) win.close(); }, delayMs);
}

const pendingReposition = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleReposition(
    toastKey: string,
    bounds: { x: number; y: number; width: number; height: number },
    isBottom: boolean,
    isRight: boolean,
    offsetX: number,
    offsetY: number
) {
    const existing = pendingReposition.get(toastKey);
    if (existing !== undefined) clearTimeout(existing);
    pendingReposition.set(toastKey, setTimeout(() => {
        pendingReposition.delete(toastKey);
        repositionStack(toastKey, bounds, isBottom, isRight, offsetX, offsetY);
    }, 0));
}

// Recompute absolute positions for every toast in a stack from scratch.
// Called both when a new toast is inserted (using estimated height) and after
// its height is measured (using actual height), so interleaved notifications
// never accumulate positioning drift.
function repositionStack(
    toastKey: string,
    bounds: { x: number; y: number; width: number; height: number },
    isBottom: boolean,
    isRight: boolean,
    offsetX: number,
    offsetY: number
) {
    const stack = toastStacks.get(toastKey);
    if (!stack) return;
    let accumulated = offsetY;
    for (const e of stack) {
        if (e.win.isDestroyed()) continue;
        const x = Math.round(isRight ? bounds.x + bounds.width - TOAST_W - offsetX : bounds.x + offsetX);
        const y = isBottom
            ? Math.round(bounds.y + bounds.height - e.h - accumulated)
            : Math.round(bounds.y + accumulated);
        animateWindowTo(e.win, x, y, TOAST_W, e.h);
        accumulated += e.h + TOAST_GAP;
    }
}

// Per-channel debounce buffer. Keyed by channelId — Discord's channel IDs are globally
// unique, so a single map serves DMs, server channels, and threads. The buffer always
// holds the LATEST notification's content (newer wins); intermediate messages are dropped
// in favor of the most recent one but contribute to the count shown in the title.
// Timer is set on first arrival and NOT reset on subsequent arrivals — this caps the
// per-toast latency at coalesceWindowMs regardless of burst length.
interface CoalesceBuffer {
    timer: ReturnType<typeof setTimeout>;
    count: number;
    notif: any;
    rawTitle: string;
    rawBody: string;
    avatarPath: string;
    navData: { channelId: string; messageId: string; } | null;
    // Wall-clock of the first arrival in this buffer — used by diagnostics to log
    // the ACTUAL flush latency, which may exceed coalesceWindowMs under event-loop
    // pressure (the setTimeout is a floor, not a ceiling).
    firstAddedAt: number;
}
const coalesceBuffers = new Map<string, CoalesceBuffer>();

function flushCoalesceBuffer(channelId: string): void {
    const buf = coalesceBuffers.get(channelId);
    if (!buf) return;
    coalesceBuffers.delete(channelId);
    const cfg = mainToastConfig;
    if (!cfg) return;
    logDiag("coalesce-flush", `channel=${channelId} count=${buf.count} latencyMs=${Date.now() - buf.firstAddedAt}`);
    // Append "(N new)" to the raw title BEFORE template substitution so it appears
    // ahead of the (#channel, Category) context that buildUpdateData parses out. The
    // title parser in buildUpdateData looks for `\s+\(#` to find the context group,
    // so "Alice (3 new) (#general, Chat)" still parses correctly as displayName=
    // "Alice (3 new)" / channel=#general / category=Chat. For DMs ("Alice"), the
    // result is just "Alice (3 new)" / "Direct Message".
    const titleWithCount = buf.count > 1 ? `${buf.rawTitle} (${buf.count} new)` : buf.rawTitle;
    emitToast(cfg, buf.notif, titleWithCount, buf.rawBody, buf.avatarPath, buf.navData);
}

function flushAllCoalesceBuffers(): void {
    // Take a snapshot so flushCoalesceBuffer's delete doesn't mutate during iteration.
    const keys = Array.from(coalesceBuffers.keys());
    for (const k of keys) {
        const buf = coalesceBuffers.get(k);
        if (buf) clearTimeout(buf.timer);
        flushCoalesceBuffer(k);
    }
}

function emitToast(
    cfg: ToastConfig,
    notifInstance: any,
    rawTitle: string,
    rawBody: string,
    avatarPath: string,
    navData: { channelId: string; messageId: string; } | null
): void {
    const onClicked = cfg.redirectOnClick ? () => {
        // Emit click so Discord focuses its window and navigates to the channel.
        notifInstance.emit("click");
        if (!senderWebContents || senderWebContents.isDestroyed()) return;
        // After a short pause, scroll to the specific message that triggered the toast.
        // Preferred path: navData (channelId+messageId from toastXml) → call jumpToMessage
        // directly. Fallback path (when Discord omits launch from toastXml — which is
        // the current behavior on at least one build): defer to a renderer-side helper
        // `__npJumpFromTitle` that parses the title's "(#channel, Category)" context and
        // looks up the channel's most-recent message via a FluxDispatcher subscription
        // installed by index.tsx.
        setTimeout(() => {
            if (!senderWebContents || senderWebContents.isDestroyed()) return;
            if (navData) {
                const cId = JSON.stringify(navData.channelId);
                const mId = JSON.stringify(navData.messageId);
                senderWebContents.executeJavaScript(
                    `(function(){try{` +
                    `var m=window?.Vencord?.Webpack?.findByProps?.("jumpToMessage");` +
                    `m?.jumpToMessage?.({channelId:${cId},messageId:${mId},flash:true});` +
                    `}catch(e){}})();`
                ).catch(err => logErr("jump-to-message", err));
            } else {
                const t = JSON.stringify(rawTitle);
                senderWebContents.executeJavaScript(
                    `(function(){try{window.__npJumpFromTitle&&window.__npJumpFromTitle(${t});}catch(e){}})();`
                ).catch(err => logErr("jump-from-title", err));
            }
        }, 300);
    } : undefined;

    showToastInternal({
        ...cfg,
        title: cfg.titleTemplate.replace("{title}", rawTitle),
        body: cfg.bodyTemplate.replace("{body}", rawBody),
        icon: cfg.iconUrl || "",
        // If user has a custom iconUrl override, no path-read is needed. Otherwise pass
        // the raw path so showToastInternal resolves it only on the surviving path.
        iconPath: cfg.iconUrl ? "" : avatarPath,
    }, onClicked);
}

async function processNotification(notif: InstanceType<typeof ElectronNotification>): Promise<void> {
    const cfg = mainToastConfig;
    if (!cfg) return;

    let title = stripBidi(notif.title ?? "");
    let body = stripBidi(notif.body ?? "");
    let avatarPath = "";

    const xml = (notif as any).toastXml as string | undefined;
    if (xml) {
        if (!title && !body) {
            const extracted = extractFromToastXml(xml);
            title = extracted.title;
            body = extracted.body;
        }
        // Defer the read+base64 to showToastInternal — if this toast loses the
        // burst-skip check, the disk I/O is avoided entirely.
        avatarPath = extractImageFromToastXml(xml);
    }

    // Nav data is needed by either redirectOnClick (jump-to-message) or coalescing
    // (channelId as buffer key). Skip the regex work when neither is on.
    const needsNavData = cfg.redirectOnClick || cfg.coalesceWindowMs > 0;
    const navData = needsNavData ? extractNavData(notif as any) : null;

    // Pick a coalesce key: prefer the real channelId (precise, survives renames);
    // fall back to a title-derived key when navData extraction fails. The fallback
    // keys server messages on "(#channel, Category)" so multiple senders in the same
    // channel coalesce together, and keys DMs on the sender username.
    const coalesceKey = cfg.coalesceWindowMs > 0
        ? (navData ? `id:${navData.channelId}` : deriveFallbackCoalesceKey(title))
        : null;

    // Coalesce-decision diagnostic — gated on npDebug. Tells you (a) that
    // processNotification fired at all (only fires on real Discord notifications,
    // NOT on the "Send test notification" button which calls Native.showToast directly),
    // (b) whether navData extraction succeeded, and (c) the actual key being used —
    // either the real channelId or the title-derived fallback.
    if (debugEnabled) {
        const xmlHasLaunch = !!xml && /\blaunch=/i.test(xml);
        logDiag("nav-extract",
            `channelId=${navData?.channelId ?? "null"} messageId=${navData?.messageId ?? "null"} ` +
            `xmlHasLaunch=${xmlHasLaunch} coalesceOn=${cfg.coalesceWindowMs > 0} ` +
            `key=${coalesceKey ?? "null"} willCoalesce=${!!coalesceKey}`);
    }

    // Coalescing path: when enabled AND we have a key (real channelId or title-derived
    // fallback), route through the per-channel debounce buffer. Notifications with no
    // usable key fall through to direct emit so they never get held up.
    if (coalesceKey) {
        const key = coalesceKey;
        const existing = coalesceBuffers.get(key);
        if (existing) {
            // Burst continuation — update with latest content, bump count. Timer is
            // intentionally NOT reset so the user sees the toast at most cfg.coalesceWindowMs
            // after the first message arrived, regardless of how long the burst runs.
            existing.count++;
            existing.notif = notif;
            existing.rawTitle = title;
            existing.rawBody = body;
            existing.avatarPath = avatarPath;
            existing.navData = navData;
            return;
        }
        coalesceBuffers.set(key, {
            timer: setTimeout(() => flushCoalesceBuffer(key), cfg.coalesceWindowMs),
            count: 1,
            notif,
            rawTitle: title,
            rawBody: body,
            avatarPath,
            navData,
            firstAddedAt: Date.now(),
        });
        return;
    }

    emitToast(cfg, notif, title, body, avatarPath, navData);
}

let mainOriginalShow: (() => void) | null = null;
let mainToastConfig: ToastConfig | null = null;

export function startMainProcessPatch(e: IpcMainInvokeEvent, config: ToastConfig): void {
    senderWebContents = e.sender;
    clampToastCaps(config);
    mainToastConfig = config;
    ensureFontCached(config.font).catch(() => {});
    // Defer pool warm-up so this IPC returns immediately. acquireWindow handles a cold
    // pool by creating on demand — first toast pays a small one-time cost if it fires
    // before setImmediate runs (rare in practice).
    setImmediate(() => warmPool());
    if (mainOriginalShow) return;

    mainOriginalShow = ElectronNotification.prototype.show;

    ElectronNotification.prototype.show = function(this: InstanceType<typeof ElectronNotification>) {
        if (!mainToastConfig) {
            mainOriginalShow!.call(this);
            return;
        }
        processNotification(this);
    };
}

export function updateMainProcessPatch(_: IpcMainInvokeEvent, config: ToastConfig): void {
    const wasCoalescing = (mainToastConfig?.coalesceWindowMs ?? 0) > 0;
    clampToastCaps(config);
    mainToastConfig = config;
    // If the user disabled coalescing while buffers held pending notifications, flush
    // them now so those messages don't sit indefinitely waiting for a timer that no
    // longer matches user intent.
    if (wasCoalescing && config.coalesceWindowMs === 0) flushAllCoalesceBuffers();
    // Settings change may raise stack/group caps — top up the pool if needed.
    setImmediate(() => warmPool());
    ensureFontCached(config.font).catch(() => {});
}

export function stopMainProcessPatch(_: IpcMainInvokeEvent): void {
    mainToastConfig = null;
    senderWebContents = null;
    if (!mainOriginalShow) return;
    ElectronNotification.prototype.show = mainOriginalShow;
    mainOriginalShow = null;
    for (const stack of toastStacks.values()) {
        for (const entry of stack) { if (!entry.win.isDestroyed()) entry.win.close(); }
    }
    toastStacks.clear();
    evictedCounts.clear();
    fontCache.clear();
    iconCache.clear();
    // Drop any pending coalesce buffers — plugin is off, no toasts should emit.
    for (const buf of coalesceBuffers.values()) clearTimeout(buf.timer);
    coalesceBuffers.clear();
    for (const timer of pendingReposition.values()) clearTimeout(timer);
    pendingReposition.clear();
    pendingMoves.clear();
    if (animTicker !== null) { clearInterval(animTicker); animTicker = null; }
    drainPool();
}
