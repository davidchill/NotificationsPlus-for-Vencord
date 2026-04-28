/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 David Rodriguez and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { Button } from "@webpack/common";

function applyPosition() {
    const { position, offsetX, offsetY } = settings.store;
    const isTop = position.startsWith("top");
    const isLeft = position.endsWith("left");
    const x = `${offsetX}px`;
    const y = `${offsetY}px`;
    const root = document.documentElement;
    root.style.setProperty("--np-top", isTop ? y : "unset");
    root.style.setProperty("--np-bottom", isTop ? "unset" : y);
    root.style.setProperty("--np-left", isLeft ? x : "unset");
    root.style.setProperty("--np-right", isLeft ? "unset" : x);
}

const settings = definePluginSettings({
    position: {
        description: "Corner of the screen where notifications appear",
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
        description: "Horizontal distance from the screen edge (px)",
        type: OptionType.NUMBER,
        default: 16,
        onChange: applyPosition,
    },
    offsetY: {
        description: "Vertical distance from the screen edge (px)",
        type: OptionType.NUMBER,
        default: 16,
        onChange: applyPosition,
    },
});

export default definePlugin({
    name: "NotificationsPlus",
    description: "Adds bottom-left and top-left positions and custom edge offsets to Vencord's in-app notifications",
    authors: [{ name: "David Rodriguez", id: 0n }],
    settings,

    settingsAboutComponent() {
        return (
            <Button onClick={() => showNotification({
                title: "NotificationsPlus",
                body: "This is a test notification — looking good?",
                noPersist: true,
            })}>
                Send test notification
            </Button>
        );
    },

    start() {
        applyPosition();
    },

    stop() {
        const root = document.documentElement;
        ["--np-top", "--np-bottom", "--np-left", "--np-right"].forEach(v => root.style.removeProperty(v));
    },
});
