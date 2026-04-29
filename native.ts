/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 David Rodriguez and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BrowserWindow, Notification as ElectronNotification, screen, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";

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
}

export type ToastConfig = Omit<ToastOptions, "title" | "body" | "icon"> & {
    titleTemplate: string;
    bodyTemplate: string;
    redirectOnClick: boolean;
    iconUrl: string;
};

const TOAST_W = 345;
const TOAST_MIN_H = 113;
const TOAST_MAX_H = 400;
const TOAST_GAP = 8;
const GROUP_H = 52;

// Google Fonts that need a <link> injection. System fonts (Arial, Segoe UI, etc.) are not listed here.
const GOOGLE_FONTS: Record<string, string> = {
    "Nunito": "Nunito:wght@400;500;600;700",
    "Inter": "Inter:wght@400;500;600;700",
    "Roboto": "Roboto:wght@400;500;700",
    "Poppins": "Poppins:wght@400;500;600;700",
    "Open Sans": "Open+Sans:wght@400;500;600;700",
    "Lato": "Lato:wght@400;700",
};

const DISCORD_SVG = `<svg viewBox="0 0 24 24" fill="white" width="24" height="24"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>`;

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

function buildHtml(title: string, body: string, icon: string, duration: number, clickable: boolean, font: string, titleSize: number, channelSize: number, bodySize: number) {
    const durationMs = duration * 1000;
    const iconContent = icon
        ? `<img class="icon" src="${escapeHtml(icon)}" onerror="this.style.display='none'" />`
        : DISCORD_SVG;
    const onclick = clickable ? "location.href='vc-np://click'" : "window.close()";
    const fontQuery = GOOGLE_FONTS[font];
    const fontLink = fontQuery
        ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${fontQuery}&display=swap">`
        : "";

    // Discord notification title format: "Username (#channel-name, Category)"
    // Confirmed via toastXml inspection: only 2 text elements exist — title and body.
    // The server name is not present anywhere in the notification data Discord sends.
    //
    // Category names may themselves contain parentheses (e.g. "Community (Non-GTA)"),
    // so we locate the "(" that opens the "#..." context group and walk to its
    // matching ")" via paren balancing rather than stopping at the first ")".
    const raw = title.trim();
    let displayName = raw;
    let categoryDisplay = "";
    let channelDisplay = "";

    const ctxIdx = raw.search(/\s+\(#/);
    if (ctxIdx !== -1) {
        const openIdx = raw.indexOf("(", ctxIdx);
        let depth = 0;
        let closeIdx = -1;
        for (let i = openIdx; i < raw.length; i++) {
            if (raw[i] === "(") depth++;
            else if (raw[i] === ")") {
                if (--depth === 0) { closeIdx = i; break; }
            }
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
    const messageText = body;
    const isDM = !channelDisplay && !categoryDisplay;

    // Detect the first URL in the body for the "Open Link" button.
    const firstUrlMatch = messageText.match(/https?:\/\/[^\s]+/);
    const firstUrl = firstUrlMatch ? firstUrlMatch[0] : null;
    const openLinkHref = firstUrl ? `vc-np://open-link/${encodeURIComponent(firstUrl)}` : null;
    const bodyExtraPad = firstUrl ? "padding-bottom:26px;" : "";

    // DMs use Discord's green accent; server messages use blurple.
    const accentDark  = isDM ? "#23a55a" : "#5865f2";
    const accentLight = isDM ? "#1a8a47" : "#5865f2";
    const borderDark  = isDM ? "rgba(35,165,90,.35)"  : "rgba(88,101,242,.35)";
    const borderLight = isDM ? "rgba(35,165,90,.3)"   : "rgba(88,101,242,.3)";
    const catDark     = isDM ? "rgba(35,165,90,.6)"   : "rgba(88,101,242,.6)";
    const catLight    = isDM ? "rgba(35,165,90,.7)"   : "rgba(88,101,242,.7)";
    const hoverBg     = isDM ? "rgba(35,165,90,.12)"  : "rgba(88,101,242,.12)";
    const iconBg      = isDM ? "#23a55a" : "#5865f2";

    return `<!DOCTYPE html><html><head><meta charset="utf-8">${fontLink}<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:auto;background:transparent;overflow:hidden}
body{font-family:"${font}","Segoe UI",-apple-system,BlinkMacSystemFont,sans-serif;-webkit-font-smoothing:antialiased}
:root{--bg:#2b2d31;--bg-hover:#32353b;--title:#f2f3f5;--text:#b5bac1;--border:${borderDark};--shadow:0 16px 48px rgba(0,0,0,.65),0 0 0 1px var(--border);--accent:${accentDark};--category:${catDark}}
@media(prefers-color-scheme:light){:root{--bg:#ffffff;--bg-hover:#f2f3f5;--title:#060607;--text:#4e5058;--border:${borderLight};--shadow:0 8px 32px rgba(0,0,0,.18),0 0 0 1px var(--border);--accent:${accentLight};--category:${catLight}}}
.toast{background:var(--bg);color:var(--text);border-radius:10px;border-left:4px solid var(--accent);padding:14px 16px 14px 12px;display:flex;align-items:flex-start;gap:12px;width:100%;min-height:${TOAST_MIN_H}px;box-shadow:var(--shadow);position:relative;cursor:pointer;overflow:hidden;user-select:none}
.toast:hover{background:var(--bg-hover)}
.icon-wrap{flex-shrink:0;width:44px;height:44px;border-radius:50%;background:${iconBg};display:flex;align-items:center;justify-content:center;overflow:hidden}
.icon{width:44px;height:44px;object-fit:cover;border-radius:50%}
.content{flex:1;min-width:0;padding-top:2px}
.title{font-size:${titleSize}px;font-weight:600;color:var(--title);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px}
.category{font-size:${channelSize}px;font-weight:500;color:var(--category);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:1px}
.channel{font-size:${channelSize}px;font-weight:500;color:var(--accent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:5px}
.body{font-size:${bodySize}px;line-height:1.4;color:var(--text);overflow-wrap:break-word;word-break:break-word;${bodyExtraPad}}
.mention{color:var(--accent)}.link{color:var(--accent);text-decoration:underline}
.bar{position:absolute;bottom:0;left:0;height:6px;background:var(--accent);animation:shrink ${durationMs}ms linear forwards}
@keyframes shrink{from{width:100%}to{width:0%}}
.open-link-btn{position:absolute;bottom:14px;right:12px;font-size:10px;font-weight:600;color:var(--accent);background:transparent;border:1px solid var(--accent);border-radius:4px;padding:2px 7px;text-decoration:none;cursor:pointer;opacity:.8;letter-spacing:.02em;transition:opacity .15s,background .15s}
.open-link-btn:hover{opacity:1;background:${hoverBg}}
</style></head><body>
<div class="toast" onclick="${onclick}" oncontextmenu="window.close()">
  <div class="icon-wrap">${iconContent}</div>
  <div class="content">
    <div class="title">${escapeHtml(displayName)}</div>
    ${isDM ? `<div class="channel">Direct Message</div>` : ""}
    ${categoryDisplay ? `<div class="category">${escapeHtml(categoryDisplay)}</div>` : ""}
    ${channelDisplay ? `<div class="channel">${escapeHtml(channelDisplay)}</div>` : ""}
    <div class="body">${formatBody(messageText)}</div>
  </div>
  ${openLinkHref ? `<a class="open-link-btn" href="${openLinkHref}" onclick="event.stopPropagation()">Open Link &#8599;</a>` : ""}
  ${duration > 0 ? '<div class="bar"></div>' : ""}
</div>
</body></html>`;
}

// ── Displays & toast window ──────────────────────────────────────────────────

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
    ).catch(() => {});
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
    offsetY: number
): Promise<void> {
    const stack = toastStacks.get(toastKey)!;
    const groupWin = new BrowserWindow({
        x: 0, y: 0, width: TOAST_W, height: GROUP_H,
        show: false, frame: false, alwaysOnTop: true, transparent: true,
        skipTaskbar: true, resizable: false, movable: false, focusable: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const groupEntry: StackEntry = { win: groupWin, h: GROUP_H, isGroup: true };
    stack.push(groupEntry);

    groupWin.on("closed", () => {
        evictedCounts.set(toastKey, 0);
        const s = toastStacks.get(toastKey);
        if (s) { const i = s.findIndex(e => e.win === groupWin); if (i !== -1) s.splice(i, 1); }
    });

    const html = buildGroupHtml(count, isDM, font, channelSize);
    await groupWin.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
    repositionStack(toastKey, bounds, isBottom, isRight, offsetX, offsetY);
    if (!groupWin.isDestroyed()) groupWin.show();
}

// True when the notification title has no Discord channel context "(#channel, Category)".
// Used to select DM-specific positioning before building the window.
function isDMTitle(title: string): boolean {
    return title.trim().search(/\s+\(#/) === -1;
}

async function showToastInternal(options: ToastOptions, onClicked?: () => void): Promise<number> {
    const isDM = isDMTitle(options.title);
    const corner = isDM ? options.dmCorner : options.corner;
    const displayIndex = isDM ? options.dmDisplayIndex : options.displayIndex;
    const offsetX = isDM ? options.dmOffsetX : options.offsetX;
    const offsetY = isDM ? options.dmOffsetY : options.offsetY;

    const toastKey = `${displayIndex}-${corner}`;
    if (!toastStacks.has(toastKey)) toastStacks.set(toastKey, []);
    const stack = toastStacks.get(toastKey)!;

    // DMs use their own stack cap (group threshold); server messages use stackSize.
    const maxStack = isDM
        ? Math.max(2, options.dmGroupThreshold ?? 5)
        : Math.max(1, Math.min(5, options.stackSize ?? 3));

    // Evict the oldest full (non-group) toast(s) to make room.
    // For DMs, evicted toasts feed a group summary window instead of being silently dropped.
    const fullEntries = () => stack.filter(e => !e.isGroup);
    while (fullEntries().length >= maxStack) {
        const full = fullEntries();
        const oldest = full[full.length - 1];
        const idx = stack.indexOf(oldest);
        if (idx !== -1) stack.splice(idx, 1);
        if (!oldest.win.isDestroyed()) oldest.win.close();

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
                await createGroupWindow(toastKey, evicted, isDM, options.font, options.channelSize, bounds, isBottom, isRight, offsetX, offsetY);
            }
        }
    }

    // Initial window position for slot 0 (will be corrected by repositionStack).
    const x = Math.round(isRight ? bounds.x + bounds.width - TOAST_W - offsetX : bounds.x + offsetX);
    const y = isBottom
        ? Math.round(bounds.y + bounds.height - TOAST_MIN_H - offsetY)
        : Math.round(bounds.y + offsetY);

    const win = new BrowserWindow({
        x, y,
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
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    // Register immediately — before any awaits — so a rapid second notification
    // sees this entry. Use estimated height; repositionStack corrects it later.
    const entry: StackEntry = { win, h: TOAST_MIN_H, isGroup: false };
    stack.unshift(entry);
    repositionStack(toastKey, bounds, isBottom, isRight, offsetX, offsetY);

    win.on("closed", () => {
        const s = toastStacks.get(toastKey);
        if (s) {
            const idx = s.findIndex(e => e.win === win);
            if (idx !== -1) s.splice(idx, 1);
        }
    });

    const html = buildHtml(options.title, options.body, options.icon, effectiveDuration, !!onClicked, options.font, options.titleSize, options.channelSize, options.bodySize);
    await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);

    // Measure actual rendered height, update the entry, and reposition the whole
    // stack from scratch. Absolute positioning means interleaved notifications
    // can't accumulate drift regardless of how they interleave.
    try {
        const contentH: number = await win.webContents.executeJavaScript(
            "document.documentElement.scrollHeight"
        );
        entry.h = Math.max(TOAST_MIN_H, Math.min(contentH, TOAST_MAX_H));
        repositionStack(toastKey, bounds, isBottom, isRight, offsetX, offsetY);
    } catch { /* window was closed before measurement completed */ }

    if (!win.isDestroyed()) win.show();

    // Handle all vc-np:// navigations: toast click and "Open Link" button.
    win.webContents.on("will-navigate", (event, url) => {
        if (!url.startsWith("vc-np://")) return;
        event.preventDefault();
        if (url.startsWith("vc-np://click")) {
            win.close();
            onClicked?.();
        } else if (url.startsWith("vc-np://open-link/")) {
            win.close();
            try {
                const targetUrl = decodeURIComponent(url.slice("vc-np://open-link/".length));
                shell.openExternal(targetUrl);
            } catch { /* malformed URL */ }
        }
    });

    if (effectiveDuration > 0) {
        setTimeout(() => {
            if (!win.isDestroyed()) win.close();
        }, effectiveDuration * 1000);
    }

    return win.id;
}

// IPC-callable version — renderer cannot pass function callbacks
export async function showToast(_: IpcMainInvokeEvent, options: ToastOptions): Promise<number> {
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
function iconPathToDataUrl(src: string): string {
    if (!src) return "";
    if (src.startsWith("data:") || src.startsWith("http://") || src.startsWith("https://")) return src;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require("fs") as typeof import("fs");
        const buf = fs.readFileSync(src);
        const ext = src.split(".").pop()?.toLowerCase() ?? "png";
        const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
        return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
        return "";
    }
}

// Tracks the visible toast stack per display+corner. Keyed by "${displayIndex}-${corner}".
// Index 0 = newest (closest to corner), last index = oldest.
// Group entry (isGroup: true) is always last when present.
interface StackEntry { win: BrowserWindow; h: number; isGroup: boolean; }
const toastStacks = new Map<string, StackEntry[]>();
// Count of DM toasts evicted from the visible stack without being dismissed by the user.
// When > 0 a compact group summary window is shown at the bottom of that stack.
const evictedCounts = new Map<string, number>();

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
        e.win.setBounds({ x, y, width: TOAST_W, height: e.h });
        accumulated += e.h + TOAST_GAP;
    }
}

let mainOriginalShow: (() => void) | null = null;
let mainToastConfig: ToastConfig | null = null;

export function startMainProcessPatch(_: IpcMainInvokeEvent, config: ToastConfig): void {
    mainToastConfig = config;
    if (mainOriginalShow) return;

    mainOriginalShow = ElectronNotification.prototype.show;

    ElectronNotification.prototype.show = function(this: InstanceType<typeof ElectronNotification>) {
        if (!mainToastConfig) {
            mainOriginalShow!.call(this);
            return;
        }

        let title = stripBidi(this.title ?? "");
        let body = stripBidi(this.body ?? "");
        let avatarIcon = "";

        const xml = (this as any).toastXml as string | undefined;
        if (xml) {
            if (!title && !body) {
                const extracted = extractFromToastXml(xml);
                title = extracted.title;
                body = extracted.body;
            }
            // Discord saves the avatar to a temp file and embeds the path in toastXml.
            // Convert it to a base64 data URI so it loads in the sandboxed BrowserWindow.
            const rawPath = extractImageFromToastXml(xml);
            if (rawPath) avatarIcon = iconPathToDataUrl(rawPath);
        }

        const cfg = mainToastConfig;
        const notifInstance = this as any;
        const onClicked = cfg.redirectOnClick ? () => notifInstance.emit("click") : undefined;

        showToastInternal({
            ...cfg,
            title: cfg.titleTemplate.replace("{title}", title),
            body: cfg.bodyTemplate.replace("{body}", body),
            icon: cfg.iconUrl || avatarIcon,
        }, onClicked);
    };
}

export function updateMainProcessPatch(_: IpcMainInvokeEvent, config: ToastConfig): void {
    mainToastConfig = config;
}

export function stopMainProcessPatch(_: IpcMainInvokeEvent): void {
    mainToastConfig = null;
    if (!mainOriginalShow) return;
    ElectronNotification.prototype.show = mainOriginalShow;
    mainOriginalShow = null;
    for (const stack of toastStacks.values()) {
        for (const entry of stack) { if (!entry.win.isDestroyed()) entry.win.close(); }
    }
    toastStacks.clear();
    evictedCounts.clear();
}
