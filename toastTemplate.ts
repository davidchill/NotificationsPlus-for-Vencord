/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 David Rodriguez and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// All toast presentation lives here: the HTML/CSS shell loaded into every pool
// window, the preload script that owns DOM updates over IPC, and the dimension
// constants both files agree on. native.ts handles logic; this file handles markup.

export const TOAST_W = 345;
export const TOAST_MIN_H = 113;
export const TOAST_MAX_H = 400;
export const TOAST_GAP = 8;
export const GROUP_H = 52;

export const DISCORD_SVG = `<svg viewBox="0 0 24 24" fill="white" width="24" height="24"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>`;

// Small filled star shown beside the sender name when the message is from a friend
// (and the friend-badge style is enabled). fill="currentColor" so it inherits the
// toast accent — which is the friend accent color when accent-swap is also on.
export const FRIEND_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.2l2.95 6.36 6.85.62-5.17 4.55 1.55 6.7L12 17.5l-6.13 3.13 1.55-6.7L2.25 9.18l6.85-.62z"/></svg>`;

// Static template pre-loaded into every pool window. Dynamic values are injected via
// either the preload script (preferred — see PRELOAD_SRC below) or the inline __npUpdate
// fallback (used if preload write to temp fails at startup).
export const TEMPLATE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style id="fs"></style><style>
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
/* The countdown bar animates transform, not width. Animating width forced a layout and
   repaint of the bar on every frame for the toast's entire lifetime, in every visible
   toast at once. scaleX on its own compositor layer (will-change) is rasterized once
   and only re-composited per frame. The gradient scales with the bar exactly as it
   compressed with width before; only the horizontal spread of the glow narrows. */
@keyframes shrink{from{transform:scaleX(1)}to{transform:scaleX(0)}}
.toast{background:var(--bg);color:var(--text);border-radius:10px;border-left:4px solid var(--accent);border-top:1px solid var(--hi);padding:14px 16px 14px 12px;display:flex;align-items:flex-start;gap:12px;width:100%;min-height:${TOAST_MIN_H}px;box-shadow:var(--shadow),var(--glow);position:relative;cursor:pointer;overflow:hidden;user-select:none;transition:background .12s,transform .1s,opacity .12s}
.toast:hover{background:var(--bgh);transform:scale(1.012)}
.toast.exiting{transform:scale(0.96)!important;opacity:0!important;pointer-events:none}
.toast.timeout-exit{opacity:0!important;transition:opacity .15s ease!important;pointer-events:none}
.toast.anim-slide{animation:slide-in 220ms cubic-bezier(.22,1,.36,1) both}
.toast.anim-fade{animation:fade-in 150ms ease both}
.icon-wrap{flex-shrink:0;width:44px;height:44px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:var(--ishadow)}
.icon{width:44px;height:44px;object-fit:cover;border-radius:50%}
@keyframes icon-in{from{opacity:0}to{opacity:1}}
.icon.late{animation:icon-in .18s ease both}
.content{flex:1;min-width:0;padding-top:2px}
.title-row{display:flex;align-items:center;gap:5px;margin-bottom:2px;min-width:0}
.title{font-size:var(--ts);font-weight:600;color:var(--title);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.fbadge{flex-shrink:0;display:none;align-items:center;justify-content:center;color:var(--accent);filter:drop-shadow(0 0 4px rgba(var(--ar),var(--ag),var(--ab),.5))}
.fbadge.show{display:inline-flex}
.fbadge svg{width:calc(var(--ts) * 0.95);height:calc(var(--ts) * 0.95)}
.category{font-size:var(--cs);font-weight:500;color:var(--cat);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:1px}
.channel{font-size:var(--cs);font-weight:500;color:var(--accent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:5px}
.body{font-size:var(--bs);line-height:1.4;color:var(--text);overflow-wrap:break-word;word-break:break-word;max-height:var(--bmax);overflow:hidden}
.body.clipped{-webkit-mask-image:linear-gradient(to bottom,#000 60%,transparent);mask-image:linear-gradient(to bottom,#000 60%,transparent)}
.mention{color:var(--accent)}.link{color:var(--accent);text-decoration:underline}
.bar{position:absolute;bottom:0;left:0;width:100%;height:6px;transform-origin:0 50%;will-change:transform;background:linear-gradient(to right,var(--accent) 55%,transparent);box-shadow:0 0 8px var(--accent),0 0 2px var(--accent);display:none}
.bar.run{display:block;animation:shrink var(--bdur) cubic-bezier(0,0,.58,1) forwards}
.lbtn{position:absolute;bottom:14px;right:12px;font-size:10px;font-weight:600;color:var(--accent);background:transparent;border:1px solid var(--accent);border-radius:4px;padding:2px 7px;text-decoration:none;cursor:pointer;opacity:.8;letter-spacing:.02em;transition:opacity .15s,background .15s;display:none}
.lbtn.show{display:block}.lbtn:hover{opacity:1;background:var(--hbg)}
</style></head><body>
<div class="toast" id="t"><div class="icon-wrap" id="iw"></div><div class="content"><div class="title-row"><span class="fbadge" id="fb"></span><span class="title" id="ttl"></span></div><div class="channel" id="dml" style="display:none">Direct Message</div><div class="category" id="cat" style="display:none"></div><div class="channel" id="ch" style="display:none"></div><div class="body" id="bd"></div></div><a class="lbtn" id="lnk" onclick="event.stopPropagation()">Open Link &#8599;</a><div class="bar" id="bar"></div></div>
<script>
var SVG=${JSON.stringify(DISCORD_SVG)};
var FSVG=${JSON.stringify(FRIEND_SVG)};
// Font CSS is pushed once per window via __npFont (the preload-less fallback path
// for native.ts's pushFontIfStale) rather than riding along on every update.
window.__npFont=function(css){var fs=document.getElementById('fs');if(fs)fs.textContent=css||'';};
// Late avatar, pushed after show when the read missed the first paint (__npIcon is the
// preload-less fallback for native.ts's pushLateIcon). Empty string = read failed.
window.__npIcon=function(icon){var iw=document.getElementById('iw');if(!iw)return;if(!icon){iw.innerHTML=SVG;return;}var img=document.createElement('img');img.className='icon late';img.src=icon;img.onerror=function(){iw.innerHTML=SVG;};iw.innerHTML='';iw.appendChild(img);};
window.__npUpdate=function(d){
  var R=document.documentElement.style;
  R.setProperty('--ar',d.ar);R.setProperty('--ag',d.ag);R.setProperty('--ab',d.ab);
  R.setProperty('--ts',d.ts+'px');R.setProperty('--cs',d.cs+'px');R.setProperty('--bs',d.bs+'px');
  R.setProperty('--bmax',d.bmax+'px');R.setProperty('--sf',d.sf);R.setProperty('--bdur',d.barMs+'ms');
  document.body.style.fontFamily='"'+d.font+'","Segoe UI",-apple-system,BlinkMacSystemFont,sans-serif';
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
    // On load failure (404, bad data URI) fall back to the Discord glyph instead of
    // leaving an empty accent-colored circle.
    img.onerror=function(){iw.innerHTML=SVG;};
    iw.innerHTML='';iw.appendChild(img);
  }else{iw.innerHTML=d.ip?'':SVG;}
  document.getElementById('ttl').textContent=d.title;
  var fb=document.getElementById('fb');
  if(d.fbadge){fb.innerHTML=FSVG;fb.className='fbadge show';}else{fb.className='fbadge';fb.innerHTML='';}
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

// Preload source for toast windows. Written once per Discord launch to a temp file
// (Electron requires a file path for webPreferences.preload — can't load from a string).
// Runs in an isolated context with sandbox:true; only `electron`'s ipcRenderer/contextBridge
// and a small Node stdlib subset are available.
//
// Receiving 'np:update' here is faster than executeJavaScript because Electron uses
// structured clone instead of stringify+parse+eval, and there's no V8 compilation overhead.
// If the preload write fails at startup, sendToastUpdate falls back to the legacy
// executeJavaScript path (which is why __npUpdate is still defined in TEMPLATE_HTML).
export const PRELOAD_SRC = `"use strict";
const { ipcRenderer } = require("electron");
const SVG = ${JSON.stringify(DISCORD_SVG)};
const FSVG = ${JSON.stringify(FRIEND_SVG)};

function applyUpdate(d) {
  const R = document.documentElement.style;
  R.setProperty("--ar", d.ar);
  R.setProperty("--ag", d.ag);
  R.setProperty("--ab", d.ab);
  R.setProperty("--ts", d.ts + "px");
  R.setProperty("--cs", d.cs + "px");
  R.setProperty("--bs", d.bs + "px");
  R.setProperty("--bmax", d.bmax + "px");
  R.setProperty("--sf", d.sf);
  R.setProperty("--bdur", d.barMs + "ms");
  document.body.style.fontFamily = '"' + d.font + '","Segoe UI",-apple-system,BlinkMacSystemFont,sans-serif';
  const t = document.getElementById("t");
  const lt = window.matchMedia("(prefers-color-scheme:light)").matches;
  if (d.grad) {
    R.setProperty("--bg", lt ? d.bgL : d.bgD);
    R.setProperty("--bgh", lt ? d.bhL : d.bhD);
    t.style.backdropFilter = "blur(14px) saturate(160%)";
    t.style.webkitBackdropFilter = "blur(14px) saturate(160%)";
  } else {
    R.removeProperty("--bg");
    R.removeProperty("--bgh");
    t.style.backdropFilter = "";
    t.style.webkitBackdropFilter = "";
  }
  const iw = document.getElementById("iw");
  if (d.icon) {
    const img = document.createElement("img");
    img.className = "icon";
    img.src = d.icon;
    // On load failure (404, bad data URI) fall back to the Discord glyph instead of
    // leaving an empty accent-colored circle.
    img.onerror = function () { iw.innerHTML = SVG; };
    iw.innerHTML = "";
    iw.appendChild(img);
  } else {
    // Avatar still loading: leave the accent circle empty rather than flashing the
    // Discord glyph, which would then visibly swap. applyIcon fills it in after show.
    iw.innerHTML = d.ip ? "" : SVG;
  }
  document.getElementById("ttl").textContent = d.title;
  const fb = document.getElementById("fb");
  if (d.fbadge) { fb.innerHTML = FSVG; fb.className = "fbadge show"; }
  else { fb.className = "fbadge"; fb.innerHTML = ""; }
  const dml = document.getElementById("dml"); dml.style.display = d.isDM ? "" : "none";
  const cat = document.getElementById("cat"); cat.textContent = d.cat; cat.style.display = d.cat ? "" : "none";
  const ch = document.getElementById("ch"); ch.textContent = d.ch; ch.style.display = d.ch ? "" : "none";
  const bd = document.getElementById("bd");
  bd.innerHTML = d.bhtml;
  bd.classList.remove("clipped");
  bd.style.paddingBottom = d.lnk ? "26px" : "";
  const lnk = document.getElementById("lnk");
  if (d.lnk) { lnk.href = d.lnk; lnk.className = "lbtn show"; }
  else { lnk.className = "lbtn"; }
  const bar = document.getElementById("bar");
  bar.className = "bar";
  if (d.barMs > 0) { void bar.offsetWidth; bar.className = "bar run"; }
  t.className = "toast";
  const clk = !!d.clk;
  t.onclick = function () {
    t.classList.add("exiting");
    setTimeout(function () { clk ? (location.href = "vc-np://click") : window.close(); }, 120);
  };
  t.oncontextmenu = function () {
    t.classList.add("exiting");
    setTimeout(window.close, 120);
  };
  requestAnimationFrame(function () { void t.offsetWidth; t.className = "toast " + (d.ent === "slide" ? "anim-slide" : "anim-fade"); });
  setTimeout(function () { if (bd.scrollHeight > bd.clientHeight) bd.classList.add("clipped"); }, 0);
  return document.documentElement.scrollHeight;
}

// Late avatar, sent on np:icon once the toast is already on screen, when the avatar
// read missed the first paint. Fades in over the empty placeholder. An empty string
// means the read failed, so fall back to the Discord glyph as before.
function applyIcon(icon) {
  const iw = document.getElementById("iw");
  if (!iw) return;
  if (!icon) { iw.innerHTML = SVG; return; }
  const img = document.createElement("img");
  img.className = "icon late";
  img.src = icon;
  img.onerror = function () { iw.innerHTML = SVG; };
  iw.innerHTML = "";
  iw.appendChild(img);
}

// Applied once per window on np:font, not on every np:update. The CSS inlines every
// weight and unicode subset as base64 (~716 KB for Nunito), and assigning it to the
// style element forces a full CSSOM reparse - far too heavy to repeat per toast.
function applyFont(css) {
  const fs = document.getElementById("fs");
  if (fs) fs.textContent = css || "";
}

function applyCloseAnim() {
  const t = document.querySelector(".toast");
  if (t) t.classList.add("timeout-exit");
}

function register() {
  ipcRenderer.on("np:update", function (_e, d) {
    let h = 0;
    try { h = applyUpdate(d); } catch (e) { /* swallow */ }
    if (d && d._reply) { try { ipcRenderer.send(d._reply, h); } catch (e) {} }
  });
  ipcRenderer.on("np:font", function (_e, css) { try { applyFont(css); } catch (e) {} });
  ipcRenderer.on("np:icon", function (_e, icon) { try { applyIcon(icon); } catch (e) {} });
  ipcRenderer.on("np:close-animate", function () { try { applyCloseAnim(); } catch (e) {} });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", register);
} else {
  register();
}
`;
