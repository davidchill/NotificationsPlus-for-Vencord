/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 David Rodriguez and contributors
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
    entrance: "none" | "slide";
    gradientBg: boolean;
    bgOpacity: number;
    dmAccent: string;
    serverAccent: string;
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

function fetchBuffer(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith("https") ? require("https") : require("http");
        mod.get(url, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0" }
        }, (res: any) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                fetchBuffer(res.headers.location).then(resolve, reject);
                return;
            }
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
        }).on("error", reject);
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
    } catch { /* network error — toast will fall back to system font */ }
}

const DISCORD_SVG = `<svg viewBox="0 0 24 24" fill="white" width="24" height="24"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>`;

function hexToRgb(hex: string): [number, number, number] {
    const n = parseInt(hex.replace("#", ""), 16);
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

// Static template pre-loaded into every pool window. Dynamic values are injected via
// window.__npUpdate(data) using executeJavaScript, avoiding a full page load per notification.
// All per-toast values (accent color, sizes, content) are CSS variables or DOM updates.
const TEMPLATE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style id="fs"></style><style>
*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:auto;background:transparent;overflow:hidden}
body{-webkit-font-smoothing:antialiased}
:root{
  --ar:88;--ag:101;--ab:242;
  --accent:rgb(var(--ar),var(--ag),var(--ab));
  --border:rgba(var(--ar),var(--ag),var(--ab),.35);
  --glow:0 0 20px rgba(var(--ar),var(--ag),var(--ab),.15);
  --cat:rgba(var(--ar),var(--ag),var(--ab),.6);
  --ishadow:0 0 0 2px rgba(var(--ar),var(--ag),var(--ab),.3),0 2px 10px rgba(0,0,0,.55);
  --hbg:rgba(var(--ar),var(--ag),var(--ab),.12);
  --bg:#232428;--bgh:#2a2c31;--title:#f2f3f5;--text:#b5bac1;
  --shadow:0 16px 48px rgba(0,0,0,.65),0 0 0 1px var(--border);
  --hi:rgba(255,255,255,.07);
  --ts:14px;--cs:12px;--bs:13px;--bmax:54px;--bdur:5000ms;--sf:calc(100% + 20px)
}
@media(prefers-color-scheme:light){:root{
  --bg:#fff;--bgh:#f2f3f5;--title:#060607;--text:#4e5058;
  --shadow:0 8px 32px rgba(0,0,0,.18),0 0 0 1px var(--border);
  --hi:rgba(0,0,0,.05);
  --ishadow:0 0 0 2px rgba(var(--ar),var(--ag),var(--ab),.25),0 2px 6px rgba(0,0,0,.18);
  --glow:0 0 14px rgba(var(--ar),var(--ag),var(--ab),.12)
}}
@keyframes slide-in{from{transform:translateX(var(--sf)) scale(0.97);opacity:0}to{transform:translateX(0) scale(1);opacity:1}}
@keyframes fade-in{from{opacity:0;transform:scale(0.97)}to{opacity:1;transform:scale(1)}}
@keyframes shrink{from{width:100%}to{width:0%}}
.toast{background:var(--bg);color:var(--text);border-radius:10px;border-left:4px solid var(--accent);border-top:1px solid var(--hi);padding:14px 16px 14px 12px;display:flex;align-items:flex-start;gap:12px;width:100%;min-height:${TOAST_MIN_H}px;box-shadow:var(--shadow),var(--glow);position:relative;cursor:pointer;overflow:hidden;user-select:none;transition:background .12s,transform .1s,opacity .12s}
.toast:hover{background:var(--bgh);transform:scale(1.012)}
.toast.exiting{transform:scale(0.96)!important;opacity:0!important;pointer-events:none}
.toast.timeout-exit{opacity:0!important;transition:opacity .15s ease!important;pointer-events:none}
.toast.anim-slide{animation:slide-in 220ms cubic-bezier(.22,1,.36,1) both}
.toast.anim-fade{animation:fade-in 150ms ease both}
.icon-wrap{flex-shrink:0;width:44px;height:44px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:var(--ishadow)}
.icon{width:44px;height:44px;object-fit:cover;border-radius:50%}
.content{flex:1;min-width:0;padding-top:2px}
.title{font-size:var(--ts);font-weight:600;color:var(--title);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px}
.category{font-size:var(--cs);font-weight:500;color:var(--cat);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:1px}
.channel{font-size:var(--cs);font-weight:500;color:var(--accent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:5px}
.body{font-size:var(--bs);line-height:1.4;color:var(--text);overflow-wrap:break-word;word-break:break-word;max-height:var(--bmax);overflow:hidden}
.body.clipped{-webkit-mask-image:linear-gradient(to bottom,#000 60%,transparent);mask-image:linear-gradient(to bottom,#000 60%,transparent)}
.mention{color:var(--accent)}.link{color:var(--accent);text-decoration:underline}
.bar{position:absolute;bottom:0;left:0;height:6px;background:linear-gradient(to right,var(--accent) 55%,transparent);box-shadow:0 0 8px var(--accent),0 0 2px var(--accent);display:none}
.bar.run{display:block;animation:shrink var(--bdur) cubic-bezier(0,0,.58,1) forwards}
.lbtn{position:absolute;bottom:14px;right:12px;font-size:10px;font-weight:600;color:var(--accent);background:transparent;border:1px solid var(--accent);border-radius:4px;padding:2px 7px;text-decoration:none;cursor:pointer;opacity:.8;letter-spacing:.02em;transition:opacity .15s,background .15s;display:none}
.lbtn.show{display:block}.lbtn:hover{opacity:1;background:var(--hbg)}
</style></head><body>
<div class="toast" id="t"><div class="icon-wrap" id="iw"></div><div class="content"><div class="title" id="ttl"></div><div class="channel" id="dml" style="display:none">Direct Message</div><div class="category" id="cat" style="display:none"></div><div class="channel" id="ch" style="display:none"></div><div class="body" id="bd"></div></div><a class="lbtn" id="lnk" onclick="event.stopPropagation()">Open Link &#8599;</a><div class="bar" id="bar"></div></div>
<script>
var SVG=${JSON.stringify(DISCORD_SVG)};
window.__npUpdate=function(d){
  var R=document.documentElement.style;
  R.setProperty('--ar',d.ar);R.setProperty('--ag',d.ag);R.setProperty('--ab',d.ab);
  R.setProperty('--ts',d.ts+'px');R.setProperty('--cs',d.cs+'px');R.setProperty('--bs',d.bs+'px');
  R.setProperty('--bmax',d.bmax+'px');R.setProperty('--sf',d.sf);R.setProperty('--bdur',d.barMs+'ms');
  document.body.style.fontFamily='"'+d.font+'","Segoe UI",-apple-system,BlinkMacSystemFont,sans-serif';
  document.getElementById('fs').textContent=d.fc;
  var t=document.getElementById('t');
  var lt=window.matchMedia('(prefers-color-scheme:light)').matches;
  if(d.grad){
    R.setProperty('--bg',lt?d.bgL:d.bgD);R.setProperty('--bgh',lt?d.bhL:d.bhD);
    t.style.backdropFilter='blur(14px) saturate(160%)';t.style.webkitBackdropFilter='blur(14px) saturate(160%)';
  }else{
    R.removeProperty('--bg');R.removeProperty('--bgh');
    t.style.backdropFilter='';t.style.webkitBackdropFilter='';
  }
  var iw=document.getElementById('iw');
  if(d.icon){
    var img=document.createElement('img');
    img.className='icon';img.src=d.icon;
    img.onerror=function(){this.style.display='none';};
    iw.innerHTML='';iw.appendChild(img);
  }else{iw.innerHTML=SVG;}
  document.getElementById('ttl').textContent=d.title;
  var dml=document.getElementById('dml');dml.style.display=d.isDM?'':'none';
  var cat=document.getElementById('cat');cat.textContent=d.cat;cat.style.display=d.cat?'':'none';
  var ch=document.getElementById('ch');ch.textContent=d.ch;ch.style.display=d.ch?'':'none';
  var bd=document.getElementById('bd');
  bd.innerHTML=d.bhtml;bd.classList.remove('clipped');bd.style.paddingBottom=d.lnk?'26px':'';
  var lnk=document.getElementById('lnk');
  if(d.lnk){lnk.href=d.lnk;lnk.className='lbtn show';}else{lnk.className='lbtn';}
  var bar=document.getElementById('bar');
  bar.className='bar';if(d.barMs>0){void bar.offsetWidth;bar.className='bar run';}
  t.className='toast';
  t.onclick=function(){t.classList.add('exiting');setTimeout(function(){d.clk?location.href='vc-np://click':window.close();},120);};
  t.oncontextmenu=function(){t.classList.add('exiting');setTimeout(window.close,120);};
  // rAF defers the animation class until after win.show() — ensures animation begins from first visible frame
  requestAnimationFrame(function(){void t.offsetWidth;t.className='toast '+(d.ent==='slide'?'anim-slide':'anim-fade');});
  setTimeout(function(){if(bd.scrollHeight>bd.clientHeight)bd.classList.add('clipped');},0);
  return document.documentElement.scrollHeight;
};
</script></body></html>`;

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
        const anim = activeAnimations.get(groupWin);
        if (anim) { clearInterval(anim); activeAnimations.delete(groupWin); }
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
    let fullCount = stack.reduce((n, e) => n + (e.isGroup ? 0 : 1), 0);
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

    // Pool windows pre-load the template HTML, so acquireWindow resolves almost instantly
    // when the pool is warm. executeJavaScript then updates content in ~5-20ms vs the
    // previous loadURL approach which took 50-150ms per notification.
    const win = await acquireWindow();

    const entry: StackEntry = { win, h: TOAST_MIN_H, isGroup: false };
    stack.unshift(entry);

    win.on("closed", () => {
        const anim = activeAnimations.get(win);
        if (anim) { clearInterval(anim); activeAnimations.delete(win); }
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
    if (!fontCss && GOOGLE_FONTS[options.font]) ensureFontCached(options.font).catch(() => {});

    const updateData = buildUpdateData(options, effectiveDuration, !!onClicked, isRight, fontCss);

    // __npUpdate returns scrollHeight, combining content update and height measurement
    // into a single IPC round-trip. Height is measured after a forced layout so it's accurate.
    let measuredH = TOAST_MIN_H;
    try {
        const contentH: number = await win.webContents.executeJavaScript(
            `window.__npUpdate(${JSON.stringify(updateData)})`
        );
        measuredH = Math.max(TOAST_MIN_H, Math.min(contentH, TOAST_MAX_H));
    } catch { /* window was closed before update */ }

    entry.h = measuredH;
    if (!win.isDestroyed()) {
        // Reposition with the measured height before showing — toast appears at the right
        // position immediately with no post-show correction jump.
        repositionStack(toastKey, bounds, isBottom, isRight, offsetX, offsetY);
        win.show();
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
            } catch { /* malformed URL */ }
        }
    });

    if (effectiveDuration > 0) {
        setTimeout(() => {
            closeWithAnimation(win);
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
const ICON_CACHE_MAX = 50;
const iconCache = new Map<string, string>();

async function iconPathToDataUrl(src: string): Promise<string> {
    if (!src) return "";
    if (src.startsWith("data:") || src.startsWith("http://") || src.startsWith("https://")) return src;
    if (iconCache.has(src)) return iconCache.get(src)!;
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
interface StackEntry { win: BrowserWindow; h: number; isGroup: boolean; }
const toastStacks = new Map<string, StackEntry[]>();
// Count of DM toasts evicted from the visible stack without being dismissed by the user.
// When > 0 a compact group summary window is shown at the bottom of that stack.
const evictedCounts = new Map<string, number>();

const POOL_SIZE = 4;
const windowPool: BrowserWindow[] = [];

// Tracks when each pool window has finished loading the template HTML.
// acquireWindow awaits this before handing the window to showToastInternal,
// ensuring executeJavaScript can run immediately without page-ready races.
const poolReady = new WeakMap<BrowserWindow, Promise<void>>();

function createPoolWindow(): BrowserWindow {
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
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    poolReady.set(w, w.loadURL(`data:text/html;base64,${TEMPLATE_B64}`));
    return w;
}

function warmPool(): void {
    while (windowPool.length < POOL_SIZE) {
        windowPool.push(createPoolWindow());
    }
}

async function acquireWindow(): Promise<BrowserWindow> {
    while (windowPool.length > 0) {
        const w = windowPool.pop()!;
        if (!w.isDestroyed()) {
            await poolReady.get(w);
            process.nextTick(warmPool);
            return w;
        }
    }
    process.nextTick(warmPool);
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

const activeAnimations = new WeakMap<BrowserWindow, ReturnType<typeof setInterval>>();

function animateWindowTo(win: BrowserWindow, x: number, y: number, w: number, h: number) {
    const prev = activeAnimations.get(win);
    if (prev) { clearInterval(prev); activeAnimations.delete(win); }

    if (!win.isVisible()) {
        win.setBounds({ x, y, width: w, height: h });
        return;
    }

    const start = win.getBounds();
    if (start.x === x && start.y === y && start.width === w && start.height === h) return;

    if (Math.abs(x - start.x) <= 3 && Math.abs(y - start.y) <= 3 && start.width === w && start.height === h) {
        win.setBounds({ x, y, width: w, height: h });
        return;
    }

    const steps = 8;
    const stepMs = 15;
    let step = 0;

    const interval = setInterval(() => {
        step++;
        if (win.isDestroyed()) { clearInterval(interval); activeAnimations.delete(win); return; }
        const t = step / steps;
        const ease = 1 - Math.pow(1 - t, 3);
        win.setBounds({
            x: Math.round(start.x + (x - start.x) * ease),
            y: Math.round(start.y + (y - start.y) * ease),
            width: w,
            height: h,
        });
        if (step >= steps) { clearInterval(interval); activeAnimations.delete(win); }
    }, stepMs);

    activeAnimations.set(win, interval);
}

function closeWithAnimation(win: BrowserWindow, delayMs = 150) {
    if (win.isDestroyed()) return;
    win.webContents.executeJavaScript(
        "var t=document.querySelector('.toast');if(t)t.classList.add('timeout-exit')"
    ).catch(() => {});
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

async function processNotification(notif: InstanceType<typeof ElectronNotification>): Promise<void> {
    const cfg = mainToastConfig;
    if (!cfg) return;

    let title = stripBidi(notif.title ?? "");
    let body = stripBidi(notif.body ?? "");
    let avatarIcon = "";

    const xml = (notif as any).toastXml as string | undefined;
    if (xml) {
        if (!title && !body) {
            const extracted = extractFromToastXml(xml);
            title = extracted.title;
            body = extracted.body;
        }
        const rawPath = extractImageFromToastXml(xml);
        if (rawPath) avatarIcon = await iconPathToDataUrl(rawPath);
    }

    const notifInstance = notif as any;
    const onClicked = cfg.redirectOnClick ? () => notifInstance.emit("click") : undefined;

    showToastInternal({
        ...cfg,
        title: cfg.titleTemplate.replace("{title}", title),
        body: cfg.bodyTemplate.replace("{body}", body),
        icon: cfg.iconUrl || avatarIcon,
    }, onClicked);
}

let mainOriginalShow: (() => void) | null = null;
let mainToastConfig: ToastConfig | null = null;

export function startMainProcessPatch(_: IpcMainInvokeEvent, config: ToastConfig): void {
    mainToastConfig = config;
    ensureFontCached(config.font).catch(() => {});
    warmPool();
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
    mainToastConfig = config;
    ensureFontCached(config.font).catch(() => {});
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
    fontCache.clear();
    iconCache.clear();
    for (const timer of pendingReposition.values()) clearTimeout(timer);
    pendingReposition.clear();
    drainPool();
}
