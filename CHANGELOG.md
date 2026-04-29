# Changelog

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
