# Changelog

## v0.1.0 — 2026-04-27

Initial release.

### Added
- **4-corner positioning** — choose Top Right, Top Left, Bottom Right, or Bottom Left from plugin settings. Vencord's built-in overlay only supports Top Right and Bottom Right.
- **Custom edge offsets** — separate horizontal (X) and vertical (Y) pixel offset fields control how far from each screen edge the notification sits. Default is 16 px on both axes.
- **Live settings update** — position and offsets update immediately when changed; no Discord restart required.
- **Test notification button** — a "Send test notification" button in the plugin settings panel fires a one-off notification to verify placement without waiting for a real Discord event.

### How positioning works
Position is driven entirely by CSS custom properties (`--np-top`, `--np-bottom`, `--np-left`, `--np-right`) written to `:root`. A single CSS rule applies them to `.vc-notification-root` with `!important`, which overrides both Vencord's hardcoded `right: 1rem` and the inline top/bottom styles set by `NotificationComponent` — no webpack patches required.
