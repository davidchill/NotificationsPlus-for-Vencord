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
}

export type ToastConfig = Omit<ToastOptions, "title" | "body" | "icon"> & {
    titleTemplate: string;
    bodyTemplate: string;
    redirectOnClick: boolean;
};

const TOAST_W = 320;
const TOAST_H = 88;

const DISCORD_SVG = `<svg viewBox="0 0 24 24" fill="white" width="20" height="20"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>`;

function escapeHtml(s: string) {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function buildHtml(title: string, body: string, icon: string, duration: number, clickable: boolean) {
    const durationMs = duration * 1000;
    const iconContent = icon
        ? `<img class="icon" src="${escapeHtml(icon)}" onerror="this.style.display='none'" />`
        : DISCORD_SVG;
    const onclick = clickable ? "location.href='vc-np://click'" : "window.close()";

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:transparent;overflow:hidden}
body{font-family:"Segoe UI",-apple-system,BlinkMacSystemFont,sans-serif;-webkit-font-smoothing:antialiased}
.toast{background:#2b2d31;color:#dbdee1;border-radius:8px;padding:12px 14px;display:flex;align-items:flex-start;gap:10px;width:100%;height:100%;box-shadow:0 8px 24px rgba(0,0,0,.4),0 0 0 1px rgba(255,255,255,.06);position:relative;cursor:pointer;overflow:hidden;user-select:none}
.toast:hover{background:#32353b}
.icon-wrap{flex-shrink:0;width:36px;height:36px;border-radius:50%;background:#5865f2;display:flex;align-items:center;justify-content:center;overflow:hidden}
.icon{width:36px;height:36px;object-fit:cover;border-radius:50%}
.content{flex:1;overflow:hidden;padding-top:2px}
.title{font-size:13px;font-weight:600;color:#f2f3f5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:3px}
.body{font-size:13px;line-height:1.4;color:#b5bac1;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.bar{position:absolute;bottom:0;left:0;height:2px;background:#5865f2;border-radius:0 0 0 8px;animation:shrink ${durationMs}ms linear forwards}
@keyframes shrink{from{width:100%}to{width:0%}}
</style></head><body>
<div class="toast" onclick="${onclick}">
  <div class="icon-wrap">${iconContent}</div>
  <div class="content">
    <div class="title">${escapeHtml(title)}</div>
    <div class="body">${escapeHtml(body)}</div>
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
    const y = Math.round(isBottom ? bounds.y + bounds.height - TOAST_H - options.offsetY : bounds.y + options.offsetY);

    const win = new BrowserWindow({
        x, y,
        width: TOAST_W,
        height: TOAST_H,
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

    const html = buildHtml(options.title, options.body, options.icon, options.duration, !!onClicked);
    await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);

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

// Discord on Windows uses toastXml for rich notifications, leaving title/body empty.
// Extract visible text from <text> elements as a fallback.
function extractFromToastXml(xml: string): { title: string; body: string; } {
    const texts = [...xml.matchAll(/<text[^>]*>([^<]*)<\/text>/gi)]
        .map(m => unescapeXml(m[1].trim()))
        .filter(Boolean);
    return { title: texts[0] ?? "", body: texts.slice(1).join(" ") };
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

        let title = this.title ?? "";
        let body = this.body ?? "";

        if (!title && !body) {
            const xml = (this as any).toastXml as string | undefined;
            if (xml) {
                const extracted = extractFromToastXml(xml);
                title = extracted.title;
                body = extracted.body;
            }
        }

        const cfg = mainToastConfig;
        const notifInstance = this as any;
        const onClicked = cfg.redirectOnClick ? () => notifInstance.emit("click") : undefined;

        showToastInternal({
            ...cfg,
            title: cfg.titleTemplate.replace("{title}", title),
            body: cfg.bodyTemplate.replace("{body}", body),
            icon: "",
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
