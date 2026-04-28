/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 David Rodriguez and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { PluginNative } from "@utils/types";
import definePlugin, { OptionType } from "@utils/types";
import { Button, React } from "@webpack/common";

import type { DisplayInfo, ToastOptions } from "./native";

const Native = VencordNative.pluginHelpers.NotificationsPlus as PluginNative<typeof import("./native")>;

// ── In-app overlay positioning ──────────────────────────────────────────────

function applyPosition() {
    const { position, offsetX, offsetY } = settings.store;
    const isTop = position.startsWith("top");
    const isLeft = position.endsWith("left");
    const root = document.documentElement;
    root.style.setProperty("--np-top", isTop ? `${offsetY}px` : "unset");
    root.style.setProperty("--np-bottom", isTop ? "unset" : `${offsetY}px`);
    root.style.setProperty("--np-left", isLeft ? `${offsetX}px` : "unset");
    root.style.setProperty("--np-right", isLeft ? "unset" : `${offsetX}px`);
}

// ── Native toast interception ────────────────────────────────────────────────

let OriginalNotification: typeof window.Notification | null = null;

function applyToastPatch() {
    if (OriginalNotification) return;
    OriginalNotification = window.Notification;

    function PatchedNotification(title: string, options?: NotificationOptions) {
        const {
            toastDisplayIndex, toastCorner, toastOffsetX, toastOffsetY,
            toastDuration, toastTitleTemplate, toastBodyTemplate, toastIconUrl,
        } = settings.store;

        Native.showToast({
            title: toastTitleTemplate.replace("{title}", title),
            body: toastBodyTemplate.replace("{body}", options?.body ?? ""),
            icon: toastIconUrl || (options as any)?.icon || "",
            displayIndex: toastDisplayIndex,
            corner: toastCorner as ToastOptions["corner"],
            offsetX: toastOffsetX,
            offsetY: toastOffsetY,
            duration: toastDuration,
        });

        return { onclick: null, onclose: null, close() { } };
    }

    Object.defineProperty(PatchedNotification, "permission", {
        get: () => "granted" as NotificationPermission,
        configurable: true,
    });
    (PatchedNotification as any).requestPermission = async () => "granted" as NotificationPermission;

    (window as any).Notification = PatchedNotification;
}

function removeToastPatch() {
    if (!OriginalNotification) return;
    window.Notification = OriginalNotification;
    OriginalNotification = null;
}

// ── Settings ─────────────────────────────────────────────────────────────────

const settings = definePluginSettings({
    // In-app overlay
    position: {
        description: "Corner where Vencord's in-app notifications appear",
        type: OptionType.SELECT,
        options: [
            { label: "Bottom Right", value: "bottom-right", default: true },
            { label: "Bottom Left", value: "bottom-left" },
            { label: "Top Right", value: "top-right" },
            { label: "Top Left", value: "top-left" },
        ],
        onChange: applyPosition,
    },
    offsetX: {
        description: "Horizontal distance from the screen edge (px) — in-app notifications",
        type: OptionType.NUMBER,
        default: 16,
        onChange: applyPosition,
    },
    offsetY: {
        description: "Vertical distance from the screen edge (px) — in-app notifications",
        type: OptionType.NUMBER,
        default: 16,
        onChange: applyPosition,
    },

    // Custom native toast
    useCustomNativeToast: {
        description: "Replace native OS notifications with a custom positionable window",
        type: OptionType.BOOLEAN,
        default: false,
        onChange: (val: boolean) => val ? applyToastPatch() : removeToastPatch(),
    },
    toastDisplayIndex: {
        description: "Monitor to show custom notifications on — see monitor list below (0 = primary)",
        type: OptionType.NUMBER,
        default: 0,
    },
    toastCorner: {
        description: "Corner for custom notifications",
        type: OptionType.SELECT,
        options: [
            { label: "Bottom Right", value: "bottom-right", default: true },
            { label: "Bottom Left", value: "bottom-left" },
            { label: "Top Right", value: "top-right" },
            { label: "Top Left", value: "top-left" },
        ],
    },
    toastOffsetX: {
        description: "Horizontal distance from screen edge (px) — custom toast",
        type: OptionType.NUMBER,
        default: 16,
    },
    toastOffsetY: {
        description: "Vertical distance from screen edge (px) — custom toast",
        type: OptionType.NUMBER,
        default: 16,
    },
    toastDuration: {
        description: "Seconds before the toast auto-dismisses (0 = stays until clicked)",
        type: OptionType.NUMBER,
        default: 5,
    },
    toastTitleTemplate: {
        description: "Title template — use {title} for the original notification title",
        type: OptionType.STRING,
        default: "{title}",
    },
    toastBodyTemplate: {
        description: "Body template — use {body} for the original notification body",
        type: OptionType.STRING,
        default: "{body}",
    },
    toastIconUrl: {
        description: "Icon URL override — leave blank to use Discord's logo",
        type: OptionType.STRING,
        default: "",
    },
});

// ── Plugin ────────────────────────────────────────────────────────────────────

export default definePlugin({
    name: "NotificationsPlus",
    description: "Adds position and offset control to Vencord's in-app notifications, and replaces native OS toasts with a fully positionable custom window",
    authors: [{ name: "David Rodriguez", id: 0n }],
    settings,

    settingsAboutComponent() {
        const [displays, setDisplays] = React.useState<DisplayInfo[]>([]);

        React.useEffect(() => {
            Native.getDisplays().then(setDisplays);
        }, []);

        function handleTest() {
            if (settings.store.useCustomNativeToast) {
                const { toastDisplayIndex, toastCorner, toastOffsetX, toastOffsetY, toastDuration } = settings.store;
                Native.showToast({
                    title: "NotificationsPlus",
                    body: "Custom toast is working — looking good?",
                    icon: "",
                    displayIndex: toastDisplayIndex,
                    corner: toastCorner as ToastOptions["corner"],
                    offsetX: toastOffsetX,
                    offsetY: toastOffsetY,
                    duration: toastDuration,
                });
            } else {
                showNotification({
                    title: "NotificationsPlus",
                    body: "This is a test notification — looking good?",
                    noPersist: true,
                });
            }
        }

        return (
            <>
                {displays.length > 0 && (
                    <div style={{ marginBottom: "8px", fontSize: "13px", color: "var(--text-muted)", lineHeight: "1.8" }}>
                        {displays.map(d => (
                            <div key={d.index}>
                                <strong style={{ color: "var(--text-normal)" }}>Monitor {d.index}</strong>
                                {d.primary ? " (primary)" : ""} — {d.label} · {d.bounds.width}×{d.bounds.height}
                            </div>
                        ))}
                    </div>
                )}
                <Button onClick={handleTest}>Send test notification</Button>
            </>
        );
    },

    start() {
        applyPosition();
        if (settings.store.useCustomNativeToast) applyToastPatch();
    },

    stop() {
        const root = document.documentElement;
        ["--np-top", "--np-bottom", "--np-left", "--np-right"].forEach(v => root.style.removeProperty(v));
        removeToastPatch();
    },
});
