/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 David Rodriguez and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BrowserWindow, Notification as ElectronNotification, screen } from "electron";
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
    duration: number;
    font: string;
    titleSize: number;
    channelSize: number;
    bodySize: number;
}

export type ToastConfig = Omit<ToastOptions, "title" | "body" | "icon"> & {
    titleTemplate: string;
    bodyTemplate: string;
    redirectOnClick: boolean;
    iconUrl: string;
};

const TOAST_W = 345;
const TOAST_MIN_H = 113;
const TOAST_MAX_H = 300;

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
    // Usernames may contain their own paren groups (e.g. "astolfo 💕 (server kitten)"),
    // so scan for paren groups and take the first one whose content starts with "#".
    const raw = title.trim();
    const parenRe = /\s+\(([^)]+)\)/g;
    let parenMatch: RegExpExecArray | null;
    let channelMatch: RegExpExecArray | null = null;
    while ((parenMatch = parenRe.exec(raw)) !== null) {
        if (parenMatch[1].trimStart().startsWith("#")) {
            channelMatch = parenMatch;
            break;
        }
    }
    let displayName: string;
    let channelDisplay: string;
    if (channelMatch) {
        displayName = raw.slice(0, channelMatch.index).trim();
        const parts = channelMatch[1].split(",").map(s => s.trim()).filter(Boolean);
        const channelName = parts[0] ?? "";
        const category = parts[1] ?? "";
        channelDisplay = category ? `${category} | ${channelName}` : channelName;
    } else {
        // DM or plain notification — no "(#channel, Category)" context found.
        displayName = raw;
        channelDisplay = "";
    }
    const messageText = body;

    return `<!DOCTYPE html><html><head><meta charset="utf-8">${fontLink}<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:auto;background:transparent;overflow:hidden}
body{font-family:"${font}","Segoe UI",-apple-system,BlinkMacSystemFont,sans-serif;-webkit-font-smoothing:antialiased}
:root{--bg:#2b2d31;--bg-hover:#32353b;--title:#f2f3f5;--text:#b5bac1;--border:rgba(88,101,242,.35);--shadow:0 16px 48px rgba(0,0,0,.65),0 0 0 1px var(--border);--accent:#5865f2}
@media(prefers-color-scheme:light){:root{--bg:#ffffff;--bg-hover:#f2f3f5;--title:#060607;--text:#4e5058;--border:rgba(88,101,242,.3);--shadow:0 8px 32px rgba(0,0,0,.18),0 0 0 1px var(--border)}}
.toast{background:var(--bg);color:var(--text);border-radius:10px;border-left:4px solid var(--accent);padding:14px 16px 14px 12px;display:flex;align-items:flex-start;gap:12px;width:100%;min-height:${TOAST_MIN_H}px;box-shadow:var(--shadow);position:relative;cursor:pointer;overflow:hidden;user-select:none}
.toast:hover{background:var(--bg-hover)}
.icon-wrap{flex-shrink:0;width:44px;height:44px;border-radius:50%;background:#5865f2;display:flex;align-items:center;justify-content:center;overflow:hidden}
.icon{width:44px;height:44px;object-fit:cover;border-radius:50%}
.content{flex:1;min-width:0;padding-top:2px}
.title{font-size:${titleSize}px;font-weight:600;color:var(--title);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px}
.channel{font-size:${channelSize}px;font-weight:500;color:var(--accent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:5px}
.body{font-size:${bodySize}px;line-height:1.4;color:var(--text);overflow-wrap:break-word;word-break:break-word}
.bar{position:absolute;bottom:0;left:0;height:3px;background:var(--accent);animation:shrink ${durationMs}ms linear forwards}
@keyframes shrink{from{width:100%}to{width:0%}}
</style></head><body>
<div class="toast" onclick="${onclick}">
  <div class="icon-wrap">${iconContent}</div>
  <div class="content">
    <div class="title">${escapeHtml(displayName)}</div>
    ${channelDisplay ? `<div class="channel">${escapeHtml(channelDisplay)}</div>` : ""}
    <div class="body">${escapeHtml(messageText)}</div>
  </div>
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

async function showToastInternal(options: ToastOptions, onClicked?: () => void): Promise<number> {
    const displays = screen.getAllDisplays();
    const display = displays[options.displayIndex] ?? screen.getPrimaryDisplay();
    const { bounds } = display;

    const isRight = options.corner.endsWith("right");
    const isBottom = options.corner.startsWith("bottom");
    const x = Math.round(isRight ? bounds.x + bounds.width - TOAST_W - options.offsetX : bounds.x + options.offsetX);
    const y = Math.round(isBottom ? bounds.y + bounds.height - TOAST_MIN_H - options.offsetY : bounds.y + options.offsetY);

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

    const html = buildHtml(options.title, options.body, options.icon, options.duration, !!onClicked, options.font, options.titleSize, options.channelSize, options.bodySize);
    await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);

    // Measure rendered content height and expand the window to fit, then show.
    // We defer show until after resize so the window never flashes at the wrong size.
    try {
        const contentH: number = await win.webContents.executeJavaScript(
            "document.documentElement.scrollHeight"
        );
        const newH = Math.max(TOAST_MIN_H, Math.min(contentH, TOAST_MAX_H));
        if (newH !== TOAST_MIN_H) {
            const newY = isBottom
                ? Math.round(bounds.y + bounds.height - newH - options.offsetY)
                : y;
            win.setBounds({ x, y: newY, width: TOAST_W, height: newH });
        }
    } catch { /* window was closed before measurement completed */ }

    if (!win.isDestroyed()) win.show();

    // Intercept the navigation triggered by clicking the toast
    if (onClicked) {
        win.webContents.on("will-navigate", (event, url) => {
            if (url.startsWith("vc-np://")) {
                event.preventDefault();
                win.close();
                onClicked();
            }
        });
    }

    if (options.duration > 0) {
        setTimeout(() => {
            if (!win.isDestroyed()) win.close();
        }, options.duration * 1000);
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
}
