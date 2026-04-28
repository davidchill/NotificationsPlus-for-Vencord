# Changelog

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
