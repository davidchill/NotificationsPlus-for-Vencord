# Changelog

## v0.2.1 — 2026-05-24

Focused burst-performance pass targeting the "notifications=All on a busy server" scenario where a tight stream of arrivals previously caused window-pool churn, redundant disk I/O, and overlapping reposition animations. Three changes work together to make the hot path do nothing for arrivals that the user can't perceive anyway.

### Changed

- **Burst-skip** — `showToastInternal` now exits early when the stack is at cap **and** the oldest visible toast is still younger than `BURST_THRESHOLD_MS` (500 ms). For DMs, the skipped toast bumps the existing "N earlier messages" group counter (no information loss). For servers, it is dropped silently. Eliminates the create→show→evict→close churn that previously fired for every burst arrival past the cap; in a 10-toast burst with `stackSize=3` this is ~7 BrowserWindow allocations + DWM compositor cycles avoided.
- **Deferred avatar I/O** — `processNotification` no longer calls `iconPathToDataUrl` inline. The raw path is passed to `showToastInternal` as a new `iconPath` field on `ToastOptions` and resolved only **after** the burst-skip check passes, so dropped bursts pay no disk read. The resolve is also parallelized with `acquireWindow` via `Promise.all` so the two independent waits no longer serialize.
- **Single-window position + scheduled full reposition** — the new toast's slot is computed and applied directly (it's always at the corner, no preceding heights to sum), and the shifts of existing toasts are routed through the existing per-stack `scheduleReposition` coalescer so concurrent arrivals in the same tick collapse into one full-stack pass instead of N.

### Internal

- New `BURST_THRESHOLD_MS = 500` constant in `native.ts`.
- `StackEntry` interface gains an `addedAt: number` field set at every push site (both `showToastInternal` and `createGroupWindow`). The burst-skip freshness check reads this without any timing-source allocations.
- `ToastOptions` gains an optional `iconPath?: string` field. `ToastConfig` is unchanged — `processNotification` derives `iconPath` per-call from the `toastXml` extraction. The renderer-side `Native.showToast` IPC path and `handleTest` flow continue passing only `icon` and are unaffected.
- Settings panel, all visual settings, sound suppression, and the v0.2.0 preload/IPC and pool/animation systems are unchanged.

## v0.2.0 — 2026-05-24

This release is a focused tech-stack pass: every recommendation from a full architecture review (plus three follow-up polish items) landed in one batch. No user-facing behavior changes by default — but the hot path is faster, the surface area is more maintainable, and there's now a debug toggle to diagnose issues without console gymnastics.

### Added

- **Color picker for accent colors** — DM and server accent settings now use `<input type="color">` instead of free-text hex fields. Invalid input is no longer possible at the UI layer; the picker enforces `#rrggbb` and shows a lowercase monospace label of the resolved value next to the swatch.
- **Diagnostics toggle (`npDebug`)** — a new opt-in setting under a "Diagnostics" panel section. When enabled, internal errors are logged to **Discord's renderer devtools console** (`Ctrl+Shift+I` → Console tab) with a `[NotificationsPlus:<scope>]` tag and full stack trace. Scopes include `font-cache:<name>`, `group-label-update`, `open-link`, `close-animate:send`, `close-animate:exec`, and `jump-to-message`. Errors are also written to the main-process console (visible if Discord was launched from a terminal). Default off — zero cost for normal users.
- **Preload-script update channel** — toast windows now use a generated preload script (written once per Discord launch to `app.getPath('temp')/notificationsPlus-toast-preload.js`) that listens for `np:update` and `np:close-animate` IPC events. This replaces `executeJavaScript` on the per-notification hot path with `webContents.send()` — Electron's structured-clone serialization avoids the JSON-stringify + V8 parse + eval round-trip. Falls back silently to the legacy `executeJavaScript` path if the preload file write ever fails. Sandbox stays on; contextIsolation stays on.

### Changed

- **Settings IPC debounced (150 ms trailing)** — typing in number/text fields (offsets, hex colors before the picker swap) no longer fires one `updateMainProcessPatch` IPC per keystroke. Multi-char edits coalesce into a single config push after typing stops.
- **`iconCache` is now true LRU** — on cache hit the entry is removed and re-inserted so it moves to the tail of `Map`'s insertion order. Eviction now removes the truly least-recently-used entry instead of the oldest insertion, fixing a frequently-re-seen avatar getting evicted while one-shots persist.
- **Animation loop uses one shared ticker** — `animateWindowTo` previously created a fresh `setInterval` per move. Replaced with a global `pendingMoves: Map<BrowserWindow, MoveSpec>` driven by a single `setInterval` that auto-stops when the queue empties and restarts on the next move. Multiple toasts moving at once now collapse N timers into one.
- **Pool size auto-scales** — the constant `POOL_SIZE = 4` is replaced by `POOL_MIN = 4` and `POOL_MAX = 12` bounds. `targetPoolSize()` returns `clamp(POOL_MIN, POOL_MAX, stackSize + dmGroupThreshold + 1)` from current config, so users with high stack/group caps automatically get more pre-warmed windows ready.
- **`warmPool()` deferred to `setImmediate`** — `startMainProcessPatch` and `updateMainProcessPatch` no longer block their IPC return on pool creation. First toast after plugin start still has a warm window in practice; cold case falls back to on-demand creation in `acquireWindow`.
- **Stack/group caps clamped once at boundary** — new `clampToastCaps()` mutates `stackSize` (1–5) and `dmGroupThreshold` (min 2) at the IPC entry points. `showToastInternal` reads them directly without per-toast `Math.max(...)` work.
- **`hexToRgb` hardened against bad input** — accepts both 3-char and 6-char hex; on malformed input returns Discord brand purple `[88, 101, 242]` instead of silently degrading to black via the `NaN >> n → 0` JavaScript quirk.
- **`fetchBuffer` rewritten on Electron's `net` module** — replaces homegrown `https.get` with `electron.net.request`. Now respects system proxy settings, has a 10-second per-request timeout that aborts hung connections (previously could stall `ensureFontCached` indefinitely), and rejects on non-2xx/3xx status codes. Redirect handling moves to Electron's built-in policy.

### Refactored

- **Settings consumption de-duplicated** — `getToastShared()` is the single source of truth for the 22 placement/appearance settings. `getToastConfig()`, `buildToastOptions()`, `PatchedNotification`, and `handleTest` all consume it. Adding a new setting now touches one helper plus the UI cell, instead of three duplicate destructuring blocks.
- **Template HTML extracted to `toastTemplate.ts`** — the ~95-line `TEMPLATE_HTML` string, the new `PRELOAD_SRC` script, the Discord SVG fallback, and the layout dimension constants (`TOAST_W`, `TOAST_MIN_H`, `TOAST_MAX_H`, `TOAST_GAP`, `GROUP_H`) all live in a dedicated file. `native.ts` is now logic-only.

### Internal

- New module `toastTemplate.ts` (212 lines) exports presentation constants used by `native.ts`.
- New `sendToastUpdate(win, data)` consolidates the "push update + measure height" round-trip. Uses preload IPC when available with a one-shot reply channel (`np:measured-<winId>-<seq>`) and a 2-second safety timeout; otherwise falls back to the legacy `executeJavaScript(__npUpdate(...))` path.
- New `ensurePreload()` writes the preload script once per session to `app.getPath('temp')`. Returns `null` on write failure, which is the signal callers use to choose the executeJavaScript fallback.
- New `logErr(scope, err)` writes to `console.warn` AND forwards to the renderer via `senderWebContents.executeJavaScript`. Both paths gated on `debugEnabled`. The forwarding `.catch` is intentionally empty (NOT `logErr`) to prevent recursive failure loops.
- New `setDebug(enabled)` exported IPC handler stores the debug flag. `index.tsx`'s `start()` calls this so the flag persists across Discord restarts.
- New `clampToastCaps(o)` helper mutates `stackSize` and `dmGroupThreshold` in place.
- New `normalizeHex(raw, fallback)` and `ColorPicker` component in `index.tsx`.
- New `debounce<A>(fn, ms)` utility in `index.tsx`.
- New `targetPoolSize()` and `POOL_MIN` / `POOL_MAX` constants replace the `POOL_SIZE` constant.
- `pendingMoves: Map<BrowserWindow, MoveSpec>` and `animTicker` replace the old `activeAnimations: WeakMap<BrowserWindow, Interval>` per-window timer pattern.
- `replySeq` monotonic counter ensures reply-channel uniqueness across rapid toast bursts.
- `stopMainProcessPatch` now clears `pendingMoves` and the global animation ticker in addition to existing cleanup.

### CSS

- New `.np-color` flex row with embedded `<input type="color">` styling — Webkit color-swatch chrome stripped so the swatch fills the input; resolved hex value shown in monospace.

## v0.1.16 — 2026-05-03

### Performance
- **Pre-rendered template pool (major)** — eliminated `loadURL` per notification (was 50–150ms). Pool windows now pre-load a single static `TEMPLATE_HTML` page at creation time. When a notification arrives, `window.__npUpdate(data)` is called via `executeJavaScript` (~5–20ms) to inject all per-toast content and CSS custom properties without reloading the page. `__npUpdate` returns `document.documentElement.scrollHeight` directly, collapsing the content-update and height-measurement steps into one IPC round-trip. The toast is shown at the correct position before the first paint — no post-show height correction jump.
- **Icon cache** — `iconCache` Map (max 50 entries, LRU-style eviction) avoids repeated `readFile` + base64-encode for the same avatar during message bursts. Cleared on plugin stop.
- **repositionStack debounce** — `scheduleReposition()` wraps `repositionStack` with a `setTimeout(fn, 0)` debounce via a `pendingReposition` Map. Concurrent `repositionStack` calls for the same stack key during a notification burst are collapsed into one, eliminating `win.setBounds()` / `SetWindowPos` kernel call storms. All pending timers are cleared on plugin stop.
- **Pool size 2 → 4** — avoids a cold `createPoolWindow()` call on the 3rd and 4th rapid successive notifications.
- **Font fetch parallelization** — replaced sequential `for await` loop with `Promise.all`, cutting cold font load from `N × RTT` to `1 × RTT` when multiple font files must be fetched.
- **Animation timing fixed** — animation class is now applied inside `requestAnimationFrame` within `__npUpdate`. Electron defers `rAF` callbacks in hidden windows, so the animation starts from the first visible frame after `win.show()` — no clipped leading frames.

### Bug fix
- **Template literal `\'` escape** — the `onerror` attribute in the previous `innerHTML`-concatenated icon HTML used `\'` inside a TypeScript backtick template literal. The JS engine consumes the backslash, producing unescaped single quotes inside a single-quoted JS string — a syntax error that silently prevented the entire `<script>` block from parsing and caused `window.__npUpdate` to be undefined, showing blank toasts with only the default CSS. Fixed by replacing `innerHTML` string concatenation with explicit DOM element creation (`document.createElement`, `appendChild`), which avoids all string-escaping issues.

### Internal
- `TEMPLATE_HTML` / `TEMPLATE_B64` — static pre-rendered template replacing the old `buildHtml()` function. All dynamic values are expressed as CSS custom properties (`--ar`, `--ag`, `--ab`, `--ts`, etc.) updated per-toast via `__npUpdate`.
- `window.__npUpdate(data)` — JS function embedded in the template that receives a serialized `UpdateData` object, updates all DOM content and CSS custom properties, applies animation class via `rAF`, and returns `scrollHeight`.
- `buildUpdateData(options, effectiveDuration, clickable, isRight, fontCss)` — new function producing the `UpdateData` JSON object passed to `__npUpdate`, replacing `buildHtml` parameter threading.
- `poolReady: WeakMap<BrowserWindow, Promise<void>>` — tracks each pool window's `loadURL` promise so `acquireWindow` can `await` template-load completion before returning the window.
- `iconCache: Map<string, string>` and `ICON_CACHE_MAX = 50` added to `native.ts`.
- `pendingReposition: Map<string, ReturnType<typeof setTimeout>>` and `scheduleReposition()` added to `native.ts`.
- `stopMainProcessPatch` now clears `iconCache`, cancels all pending `pendingReposition` timers, and clears the map.

---

## v0.1.15 — 2026-05-03

### Added
- **Smooth exit animation** — toasts now fade out gracefully instead of vanishing. Timer-expired toasts get a gentle 150ms opacity fade. User-clicked or right-click-dismissed toasts get a faster 120ms scale-down + fade, giving tactile feedback that the interaction registered.
- **Entrance scale effect** — both the fade-in and slide-in entrance animations now include a subtle `scale(0.97) → scale(1)` transition, giving toasts a "popping into existence" feel.
- **Body text truncation with gradient fade** — long message bodies are now capped at 3 lines (calculated from body font size × 1.4 line-height × 3). When the content overflows, a gradient mask fades the bottom out smoothly instead of clipping hard. The mask is only applied when overflow is detected (via a post-render JS check), so short messages render normally.
- **Accent color customization** — two new settings under Appearance: "DM accent color" (default `#23a55a`) and "Server accent color" (default `#5865f2`). All color variants (borders, glows, category text, hover backgrounds, icon ring) are derived dynamically from the chosen hex using `hexToRgb()` and `darkenHex()`. Light-mode accent is auto-darkened by 22%.
- **BrowserWindow pooling** — two toast windows are pre-created at plugin start and kept hidden. When a notification arrives, one is grabbed instantly from the pool — no 100–200ms Chromium renderer process spawn on the hot path. After each acquire, a replacement is created asynchronously via `process.nextTick`. The pool is drained on plugin stop.
- **Google Fonts embedding** — font CSS and `.woff2` files are fetched once at plugin start (or on font setting change), base64-encoded, and cached in memory. Every toast gets the font inlined as a `<style>` block — zero network requests per notification. If the cache isn't warm yet (first notification after cold start), the toast renders with the system font fallback and the fetch runs in the background for future toasts.

### Changed
- **Timer bar easing** — the countdown bar now uses `cubic-bezier(0, 0, 0.58, 1)` (ease-out) instead of `linear`. It shrinks faster at first and slows near the end, giving a subtle "time is running out" feel.
- **Animated stack repositioning** — when a toast is dismissed and remaining toasts reposition, they now slide smoothly into place over ~120ms with a cubic ease-out curve instead of jumping instantly. Small position changes (≤3px, e.g. after height measurement corrections) skip animation and snap directly.

### Performance
- **Async file reads** — `iconPathToDataUrl` now uses `fs/promises.readFile` instead of the synchronous `fs.readFileSync`, unblocking the main Electron thread during avatar loading. The notification `show()` override delegates to an async `processNotification()` helper.
- **Eviction loop efficiency** — the toast eviction loop no longer calls `stack.filter()` on every iteration. Uses a `fullCount` counter and backwards array walk instead, eliminating redundant allocations.
- **Animation timer cleanup** — both toast and group window `closed` handlers now cancel any active repositioning animation interval immediately, preventing orphaned timers from firing `setBounds` on destroyed windows. The `animateWindowTo` destroy branch also properly cleans up the `activeAnimations` WeakMap entry.

### Internal
- `hexToRgb(hex)` and `darkenHex(hex, factor)` helpers added to `native.ts` for dynamic accent color derivation.
- `fetchBuffer(url)` added — Node.js `https.get` wrapper with redirect following, used by font cache.
- `fontCache: Map<string, string>` and `ensureFontCached(fontName)` added — async font fetch, base64 encode, and cache.
- `windowPool: BrowserWindow[]`, `createPoolWindow()`, `warmPool()`, `acquireWindow()`, `drainPool()` added for BrowserWindow pooling.
- `closeWithAnimation(win, delayMs)` added — injects `.timeout-exit` CSS class via `executeJavaScript`, waits, then closes.
- `processNotification(notif)` extracted from the `show()` override as an async helper.
- `buildHtml` signature extended with `dmAccent`, `serverAccent`, and `fontCss` parameters.
- `ToastOptions` extended with `dmAccent: string` and `serverAccent: string`.
- All hardcoded accent color values in `buildHtml` replaced with `rgba()` expressions derived from `hexToRgb()`.
- Toast `.toast` CSS gains `transition: opacity 0.12s` alongside existing background/transform transitions.
- `.toast.exiting` and `.toast.timeout-exit` CSS classes added for exit animations.
- `.body.clipped` CSS class added with `-webkit-mask-image` gradient for overflow fade.

---

## v0.1.14 — 2026-05-03

### Added
- **Frosted glass background** — when "Gradient background" is enabled, the toast now applies `backdrop-filter: blur(14px) saturate(160%)` with a semi-transparent background so the desktop and windows behind it bleed through subtly. Replaces the previous subtle solid/gradient fill with genuine depth.
- **Background opacity setting** — a new "Background opacity (0–100)" input (default 88) controls the alpha of the frosted glass background. Only shown in the settings panel when "Gradient background" is on. The hover background alpha is derived from this value (+0.06, clamped to 1.0) so the hover state always reads as slightly more solid than the base.
- **Always-on entrance fade** — the toast now fades in from `opacity: 0` over 150ms regardless of entrance animation setting. Previously, "None" entrance caused the window to snap visible with no transition. The "Slide in" animation continues to handle opacity as part of its own `@keyframes`; the two modes share the same CSS property slot so there is no conflict.

### Changed
- **Icon glow ring** — the avatar/icon circle now has a `box-shadow` accent ring (`0 0 0 2px <accent-glow>`) plus a drop shadow beneath it. Server message toasts use a blurple ring; DM toasts use green. Light mode uses a reduced-opacity variant.
- **Top highlight border** — added `border-top: 1px solid rgba(255,255,255,.07)` in dark mode / `rgba(0,0,0,.05)` in light mode. Creates a "lit from above" edge that makes the toast card feel raised rather than floating on nothing.
- **Timer bar gradient edge** — the countdown bar background changed from `var(--accent)` to `linear-gradient(to right, var(--accent) 55%, transparent 100%)`. The right (leading/shrinking) edge now fades to transparent instead of cutting off abruptly.
- **Stronger default background** — solid (non-gradient) toast background darkened from `#2b2d31` to `#232428` for better perceived contrast between card and content.
- **Hover background is now mode-aware** — `--bg-hover` is now a dynamic CSS variable computed per-toast rather than a hardcoded `#32353b`. In frosted glass mode it uses a semi-transparent value; in solid mode it uses an opaque dark/light value appropriate to the theme.

### Internal
- `op` / `hoverOp` computed variables added to `buildHtml`; gradient stop alpha values and hover alpha are derived from `bgOpacity` at render time.
- `bgHoverDark` / `bgHoverLight` computed variables replace the hardcoded `--bg-hover` token.
- `backdropCss` computed variable added; emits `backdrop-filter` + `-webkit-backdrop-filter` only when `gradientBg` is true.
- `--icon-shadow` and `--top-highlight` CSS variables added to both `:root` and the `@media(prefers-color-scheme:light)` override block.
- `slideKeyframes` now always emits a `@keyframes` block (`fade-in` when entrance is "none", `slide-in` when entrance is "slide"); `slideAnimation` always sets `animation:` on `.toast`.
- `ToastOptions` extended with `bgOpacity: number`; flows through `ToastConfig` automatically.
- `buildHtml` signature extended with `bgOpacity: number`.

---

## v0.1.13 — 2026-05-02

### Fixed
- **Toast stack repositioning on dismiss** — when a toast was dismissed, toasts below it did not move up to fill the gap. Both the regular toast `closed` handler and the group summary window `closed` handler now call `repositionStack()` after removing the entry, so the remaining stack snaps into place immediately.
- **Send Test Notification fires both toast types** — previously the test button only fired one toast, which was always treated as a DM (plain title, no `(#channel)` context). It now fires two toasts: a plain-title DM toast (green accent, "Direct Message" layout, DM corner/display settings) and a `(#general, Testing)` server toast (blurple accent, category+channel layout, regular corner/display settings). Both positioning configs can be verified in one click.

### Changed
- **Toast appears before height measurement** — `win.show()` is now called immediately after `loadURL()` resolves rather than after the `executeJavaScript(scrollHeight)` round-trip. The page is fully loaded and ready to paint at that point. Height measurement still runs afterward and calls `repositionStack()` only if the actual height differs from the initial `TOAST_MIN_H` estimate, correcting sibling positions silently. This eliminates ~50–150 ms of unnecessary delay before each toast becomes visible.

### Internal
- `toastStacks` and `evictedCounts` map entries are now deleted when a stack empties (last toast dismissed), rather than leaving behind an empty array or stale zero count. Prevents unbounded map growth over a long Discord session.
- Group window `closed` handler now deletes both map entries when the stack is empty after the group is dismissed, rather than unconditionally resetting `evictedCounts` to `0`.

---

## v0.1.12 — 2026-04-29

### Changed
- **Copyright year updated** — license headers in `index.tsx` and `native.ts` updated from 2025 to 2026.
- **Author Discord ID corrected** — `authors` entry in `definePlugin` updated from the placeholder `0n` to the real Discord user ID (`140194457222905856n`), bringing the plugin into compliance with Vencord's userplugin guidelines.

---

## v0.1.11 — 2026-04-29

### Added
- **Slide-in entrance animation** — new "Entrance animation" setting (None / Slide in, default None). When set to "Slide in", each toast animates in from the screen edge over 220 ms using a `cubic-bezier(.22,1,.36,1)` ease-out curve. Direction is corner-aware: right-anchored toasts slide in from the right, left-anchored from the left.
- **Gradient background** — new "Gradient background" toggle (default Off). When enabled, the toast background uses a subtle diagonal gradient (`135deg`) instead of a flat fill. Dark mode shifts from `#2b2d31` to `#2e303a` (a faint blue-grey tint that echoes the blurple accent); light mode shifts from `#ffffff` to `#f4f4f8`. Both variants are defined as per-notification CSS variables, so the correct value is always in scope without a global style sheet change.

### Changed
- **Accent glow on left border** — the 4px left accent stripe now emits a matching soft box-shadow (`-3px 0 14px rgba(...)`) that bleeds slightly beyond the border. Blurple (`rgba(88,101,242,.3)`) for server messages, green (`rgba(35,165,90,.3)`) for DMs in dark mode; slightly reduced opacity in light mode.
- **Glowing timer bar** — the bottom countdown progress bar now carries a matching `box-shadow` glow (`0 0 8px var(--accent), 0 0 2px var(--accent)`) so it radiates the accent color rather than being a flat stripe.
- **Hover micro-scale** — `.toast:hover` now applies `transform: scale(1.012)` with a `0.1s` ease transition, giving a subtle tactile "this is clickable" response. The background color transition is also smoothed to `0.12s`.

### Internal
- `buildHtml()` signature extended with `entrance: string`, `isRight: boolean`, and `gradientBg: boolean`.
- `bgDark` / `bgLight` computed variables added to `buildHtml`; `--bg` CSS variable is now a template expression rather than a hardcoded literal.
- `glowDark` / `glowLight` computed variables added; new `--glow` CSS variable injected into both `:root` and the `@media(prefers-color-scheme:light)` `:root` override.
- `slideKeyframes` / `slideAnimation` computed variables added; the `@keyframes slide-in` block is only emitted into the toast HTML when `entrance === "slide"`, so there is zero overhead when animation is off.
- `ToastOptions` extended with `entrance: "none" | "slide"` and `gradientBg: boolean`; both flow through `ToastConfig` automatically via `Omit`.

---

## v0.1.10 — 2026-04-29

### Added
- **Toast stacking** — up to N server-message toasts can be visible simultaneously (new "Max stacked toasts (1–5)" setting, default 3). Previously, a new notification immediately replaced the existing one ("bump and replace"). Stacked toasts are ordered newest-closest-to-corner, oldest furthest away. The DM stack uses its own separate cap driven by the group threshold setting.
- **Open Link button** — when the toast body contains a URL, a small "Open Link ↗" button appears in the bottom-right corner of the toast. Clicking it opens the URL in the system default browser via `shell.openExternal()` and dismisses the toast. Clicking the rest of the toast body still triggers the normal redirect-to-message behavior.
- **DM visual differentiation** — direct message toasts use a green (`#23a55a`) accent color throughout (border, icon background, timer bar, "Direct Message" label) instead of blurple. A "Direct Message" channel-line label replaces the Category / #channel layout for DMs.
- **Separate DM placement settings** — new "Direct Message Placement" settings panel section with independent Monitor, Corner, and offset controls for DM toasts. DMs are detected by the absence of Discord's `(#channel, Category)` context group in the notification title.
- **DM persist setting** — "Stay open until dismissed" toggle under "Direct Message Behavior". When enabled, DM toasts have no timer bar and never auto-close; the user must right-click or click to dismiss.
- **DM grouping** — when undismissed DM toasts exceed the "Group after N messages" threshold (default 5, min 2), the oldest DM is evicted from the visible stack and a compact 52px summary window appears at the bottom reading "N earlier messages". Each new eviction increments the count live (via `executeJavaScript` DOM update without reload). Dismissing the group window resets the eviction counter.

### Changed
- **Separate Category and Channel lines** — the "Category | #channel" single line used in v0.1.9 is now rendered as two separate lines: the category name in a dim purple (60% opacity of the blurple accent) and the channel name in the full blurple accent. This gives each piece of context its own visual weight.
- **Category color** — category text is now styled at 60% opacity of the blurple/green accent (`rgba(88,101,242,.6)` dark / `rgba(88,101,242,.7)` light for server messages; equivalent green values for DMs) rather than using `--text-muted`. This makes the category visually connected to the accent color hierarchy rather than appearing as generic secondary text.
- **"Placement" renamed to "Server Message Placement"** in the settings panel to distinguish it from the new DM placement section.

### Fixed
- **Toast overlap with stacking** — the previous multi-toast implementation shifted each existing toast by a relative delta before the new one was sized. A race condition between two concurrently arriving notifications caused double-shifts and visual overlap. Replaced entirely with `repositionStack()`, which recomputes every toast's absolute Y coordinate from the corner edge outward on every insertion and after every height measurement. Concurrent notifications always converge to the correct layout with no drift.
- **Category name truncation with parentheses** — category names containing their own parentheses (e.g. "Community (Non-GTA)") were truncated at the first `)` because the previous regex used `[^)]+`. Fixed with a balanced-paren walking algorithm that locates the outer Discord context group `(#channel, Category)` and finds its true matching `)` regardless of nested parens in the category name.

### Internal
- `activeToasts: Map<string, BrowserWindow>` replaced by `toastStacks: Map<string, StackEntry[]>` where `StackEntry = { win: BrowserWindow; h: number; isGroup: boolean }`.
- `evictedCounts: Map<string, number>` added — tracks per-stack DM overflow count.
- `repositionStack(toastKey, bounds, isBottom, isRight, offsetX, offsetY)` added — absolute position recomputation, called synchronously on insert and after height measurement.
- `buildGroupHtml(count, isDM, font, channelSize)` added — compact 52px group summary window HTML.
- `createGroupWindow(toastKey, count, isDM, ...)` added — async; appends group entry to end of stack and shows it.
- `updateGroupLabel(entry, count)` added — fire-and-forget `executeJavaScript` DOM update for the live count label.
- `isDMTitle(title)` added — returns true when the title has no `\s+\(#` pattern.
- `shell` added to `electron` import in `native.ts` for `shell.openExternal()`.
- `stopMainProcessPatch()` now calls `evictedCounts.clear()` in addition to closing all stacked windows.
- `ToastOptions` extended with `dmDisplayIndex`, `dmCorner`, `dmOffsetX`, `dmOffsetY`, `dmPersist`, `dmGroupThreshold`, `stackSize`.
- `GROUP_H = 52` constant added.

---

## v0.1.9 — 2026-04-28

### Added
- **@ mention highlighting** — `@username` patterns in the toast body now render in the same blurple accent color (`#5865f2`) used by the Category | Channel line, making mentions visually distinct from regular message text.
- **URL styling** — `https://` and `http://` URLs in the toast body are styled in the same accent color with an underline. Visual only — clicking the URL triggers the standard toast click handler (redirect to message or dismiss), not a browser open.

---

## v0.1.8 — 2026-04-28

### Changed
- **Settings panel redesigned as a two-column grid** — all 17 settings were previously rendered as a flat auto-generated flat list by Vencord's settings framework. They are now hidden from the auto-renderer (`hidden: true`) and replaced by a single `OptionType.COMPONENT` entry that drives a fully custom React panel. The panel is organized into two top-level sections (**In-App Overlay** and **Custom Toast Notifications**), with the toast section broken into labeled sub-groups (**Placement**, **Behavior**, **Appearance**, **Content**) rendered in a 2-column CSS grid. The monitor list and test button, previously in `settingsAboutComponent` (which renders above the settings heading), now live at the bottom of the Custom Toast section where they are contextually relevant.
- **Timer bar height increased from 3 px to 6 px** — the countdown progress bar at the bottom of the custom toast window is now more visually prominent.
- **Maximum toast height increased from 300 px to 400 px** — long messages that previously clipped at 300 px can now expand to 400 px before truncating.

### Added
- **Right-click to dismiss** — right-clicking anywhere on a custom toast now closes it immediately. Because the `BrowserWindow` has no native frame, Electron shows no context menu — the gesture dismisses cleanly with no extra UI.

### Fixed
- **Test notification now matches real notifications** — the "Send test notification" button was missing `font`, `titleSize`, `channelSize`, and `bodySize` from its `Native.showToast` call, so it rendered using the toast window's built-in defaults while real notifications used the configured values. All four parameters are now passed.
- **Number input styling** — custom number inputs (`<input type="number">`) in the settings panel were rendering as unstyled dark boxes because `--input-background` and `--input-border` don't exist in Discord's theme. Corrected to `--input-background-default` and `--text-default`, matching the variables used by other Vencord plugins.
- **`Switch` import corrected** — `Switch` was being imported from `@webpack/common` (Discord's internal component, which uses a `value` prop). The correct import for Vencord plugins is `@components/Switch`, which uses a `checked` prop.

### Internal
- `updateToast()` extracted as a named helper function, replacing repeated inline lambdas on every `onChange` handler.
- `settingsAboutComponent` removed; its content folded into `SettingsPanel`.
- Settings panel CSS classes (`np-num`, `np-subheader`, `np-toggle-row`, `np-monitor-list`) added to `style.css`.

---

## v0.1.7 — 2026-04-28

### Fixed
- **Rapid notifications no longer layer on top of each other** — when a new custom toast arrives while one is already visible in the same corner on the same display, the previous window is now closed before the new one appears ("bump and replace"). Previously, each call to `showToastInternal` created an independent `BrowserWindow` with no awareness of other open toasts, so rapid-fire messages stacked at the exact same screen coordinates.
- **Async race in bump-and-replace registration** — the initial implementation registered the new window in the `activeToasts` map only after two `await` calls (`loadURL` + `executeJavaScript`). A second notification arriving during those ~50–100 ms would find the map empty, skip the close step, and produce a second overlapping window anyway. The window is now registered in the map synchronously immediately after `new BrowserWindow()`, before any `await`.

### Internal
- `activeToasts: Map<string, BrowserWindow>` added to `native.ts`, keyed by `"${displayIndex}-${corner}"`. Each entry holds the one currently visible toast for that corner/display combination.
- `stopMainProcessPatch()` now closes all windows in `activeToasts` and clears the map when the plugin is disabled, preventing orphaned windows.

---

## v0.1.6 — 2026-04-28

### Added
- **Vertically dynamic toast height** — the custom toast now expands to fit the full message body rather than clipping at a fixed height. Minimum height is 113 px (unchanged from before); maximum is 300 px. Implemented by creating the `BrowserWindow` with `show: false`, loading the HTML, measuring `document.documentElement.scrollHeight` via `webContents.executeJavaScript`, calling `win.setBounds()` to resize (re-anchoring `y` for bottom-corner toasts so it stays flush to the edge), then calling `win.show()`. The window never flashes at the wrong size.
- **Message body no longer truncated** — removed `-webkit-line-clamp: 2` from the `.body` CSS rule; body text now wraps freely with `overflow-wrap: break-word`.
- **Font selection setting** — new "Toast Font" SELECT setting with 8 options: Nunito (default), Inter, Poppins, Roboto, Open Sans, Lato, Segoe UI (system), Arial (system). Google Fonts are loaded via a `<link>` tag injected into the toast HTML at render time; system fonts skip the network request entirely. Chromium's shared session cache means Google Fonts are warm after the first notification.
- **Per-element font size settings** — three new NUMBER settings: "Title font size" (default 14 px), "Channel line font size" (default 12 px), "Message body font size" (default 13 px). All three call `updateMainProcessPatch` on change and take effect on the next notification.

### Internal
- `TOAST_H` renamed to `TOAST_MIN_H`; `TOAST_MAX_H = 300` added as a new constant.
- `GOOGLE_FONTS` map added to `native.ts`, keying font name to Google Fonts query string for dynamic `<link>` injection.
- `ToastOptions` (and by extension `ToastConfig`) now carries `font`, `titleSize`, `channelSize`, `bodySize`.
- `buildHtml()` signature extended to accept all four new params.

---

## v0.1.5 — 2026-04-28

### Fixed
- **Toast layout: channel category and channel name now appear on one line** — Discord's notification title format is `"Username (#channel-name, Category)"` where the second comma-part is the channel *category* (e.g. `GTA`), not the server name. The previous code treated `parts[1]` as the server name and rendered it on its own separate line above the channel. It now correctly joins them as `Category | #channel-name` on a single line with accent styling. Confirmed by inspecting the live `toastXml` payload: Discord's notification contains exactly two `<text>` elements — the full title string and the message body. The server name is not present anywhere in the notification data Discord sends to the OS.

---

## v0.1.4 — 2026-04-28

### Fixed
- **Title parsing now works for all usernames** — Discord wraps every text segment inside `toastXml` `<text>` elements with Unicode bidi control characters (U+2068 First Strong Isolate / U+2069 Pop Directional Isolate) for RTL/LTR text handling. These invisible characters preceded the `#` in channel names (e.g. the actual content is `⁨#channel⁩`), causing `startsWith("#")` checks and `indexOf(" (#")` searches to silently fail. The result was that the formatted `Username / Server | Channel / Message` layout never applied — the raw unformatted title was displayed instead. Fixed by adding `stripBidi()` in `native.ts`, which strips all bidi and zero-width control characters from extracted text before any parsing occurs. Applied to both the `extractFromToastXml` path and to `this.title` / `this.body` on the `ElectronNotification` instance. Users with usernames containing parentheses (e.g. "astolfo 💕 (server kitten)") continue to parse correctly — the fix targets the channel-group paren, not any paren.
- **Removed temporary diagnostic** — a debug block that was appending raw notification titles to `%TEMP%\vencord-np-debug.txt` (added to diagnose the bidi issue) has been removed.

---

## v0.1.3 — 2026-04-28

### Fixed
- **Sender avatar now displays in custom toast** — the toast previously always showed the Discord logo. Discord embeds the sender's avatar as a temp PNG file path inside `toastXml` using single-quoted attributes (e.g. `src='C:\...\Temp\<uuid>.png'`). Two bugs prevented extraction: (1) the regex was matching double-quoted `src="..."` only, so it silently failed; (2) even if the path had been extracted, a sandboxed `BrowserWindow` loaded from a `data:` URI cannot access local `file://` paths. The fix corrects the regex to accept both quote styles and immediately reads the temp file in the main process, converting it to a base64 `data:image/...;base64,...` URI that is inlined into the toast HTML. Falls back to the Discord logo if no image is present. Works for DMs, server channel messages, and any other notification Discord fires.

### Added
- **`iconUrl` forwarded to main-process path** — the "Icon URL override" setting is now included in `ToastConfig` and respected by `startMainProcessPatch`, so a manual override takes priority over the extracted avatar on both the renderer and main-process notification paths.

---

## v0.1.2 — 2026-04-27

### Fixed
- **Notification interception now works for real Discord messages** — the previous approach only patched `window.Notification` in the renderer, which Discord bypasses by routing its own message notifications through Electron's main-process `Notification` class. The fix patches `ElectronNotification.prototype.show` directly in the main process via `native.ts`, so the intercept fires regardless of which code path Discord uses.
- **Blank custom toast content** — Discord on Windows constructs its notifications using the `toastXml` field (raw Windows Toast XML) rather than setting `title`/`body` directly on the `Notification` instance, leaving both properties as empty strings. Added `extractFromToastXml()` in `native.ts` to parse `<text>` elements from the XML as a fallback when `title` and `body` are both empty. HTML entities in the XML are unescaped before display.

### Added
- **Sound suppression** — new `suppressNotificationSound` toggle (off by default) mutes Discord's notification ping audio without affecting the visual notification. Implemented as a webpack patch on Discord's notification dispatch module (same module targeted by `onePingPerDM`): sets the `sound` property to `undefined` when the setting is enabled.
- **Click-to-navigate** — new `redirectOnClick` toggle (on by default). When enabled, clicking the custom toast fires Discord's own `click` event on the intercepted `Notification` instance, which triggers Discord's registered handler and navigates to the source channel/message. Mechanically: the toast `onclick` navigates to `vc-np://click`; the main process intercepts this via `webContents.on('will-navigate')`, cancels the navigation, closes the window, and calls `notifInstance.emit('click')`. Auto-dismiss (timer expiry) does not trigger navigation.

### Internal
- Refactored `showToast` into an internal `showToastInternal(options, onClicked?)` that accepts an optional click callback, and a thin IPC-callable `showToast` wrapper that omits the callback (renderer cannot pass functions over IPC). The main-process patch calls `showToastInternal` directly with the click callback in scope.
- Added `redirectOnClick` and template fields to `ToastConfig` so all necessary state is transferred from renderer settings to the main-process patch in a single IPC call.
- All five toast-config settings (corner, offsets, duration, templates, redirectOnClick) now have `onChange` handlers that push updated config to the main process via `Native.updateMainProcessPatch()`.

---

## v0.1.1 — 2026-04-27

### Added
- **Custom native toast window** — new toggle ("Replace native OS notifications with a custom positionable window") intercepts `window.Notification` in Discord's renderer and redirects every native OS toast to a custom Electron `BrowserWindow` instead. Implemented via a `native.ts` companion file that runs in Electron's main process with full `BrowserWindow` and `electron.screen` access.
- **Multi-monitor support** — `getDisplays()` enumerates all connected displays at startup and lists them (with index, label, and resolution) directly in the settings panel. A numeric "Monitor index" setting controls which display the custom toast appears on.
- **Per-corner positioning for custom toast** — independent corner setting (Top Right, Top Left, Bottom Right, Bottom Left) and X/Y edge offsets for the custom toast window, separate from the existing in-app overlay position controls.
- **Auto-dismiss timer with progress bar** — custom toast closes automatically after a configurable number of seconds (default 5); a blurple progress bar animates across the bottom of the toast to show time remaining. Set to 0 for click-to-dismiss only.
- **Title and body templates** — `{title}` and `{body}` placeholder strings let you reformat the notification content before it's displayed.
- **Icon URL override** — optional field to replace Discord's default logo with any image URL.
- **Context-aware test button** — the "Send test notification" button in the settings panel now fires a `Native.showToast()` test when the custom toast is enabled, or the existing Vencord in-app notification test when it is not.

### How the custom toast works
`native.ts` exports `getDisplays()` and `showToast()`. The build system auto-discovers and registers these as `VencordPluginNative_NotificationsPlus_*` IPC handlers in the main process. The renderer calls them via `VencordNative.pluginHelpers.NotificationsPlus`. `showToast()` creates a frameless, transparent, always-on-top `BrowserWindow` at computed pixel coordinates (derived from `screen.getAllDisplays()` bounds + corner + offsets), loads an inline HTML toast via a base64 data URI, and schedules a close timer. The window never steals focus from Discord (`focusable: false`).

---

## v0.1.0 — 2026-04-27

Initial release.

### Added
- **4-corner positioning** — choose Top Right, Top Left, Bottom Right, or Bottom Left from plugin settings. Vencord's built-in overlay only supports Top Right and Bottom Right.
- **Custom edge offsets** — separate horizontal (X) and vertical (Y) pixel offset fields control how far from each screen edge the notification sits. Default is 16 px on both axes.
- **Live settings update** — position and offsets update immediately when changed; no Discord restart required.
- **Test notification button** — a "Send test notification" button in the plugin settings panel fires a one-off notification to verify placement without waiting for a real Discord event.

### How positioning works
Position is driven entirely by CSS custom properties (`--np-top`, `--np-bottom`, `--np-left`, `--np-right`) written to `:root`. A single CSS rule applies them to `.vc-notification-root` with `!important`, which overrides both Vencord's hardcoded `right: 1rem` and the inline top/bottom styles set by `NotificationComponent` — no webpack patches required.
