import type { PaneManager } from "./pane-manager.ts";

export interface PaneSettings {
	enabled: boolean;
	autoClose: boolean;
	closeDelayMs: number;
	failCloseDelayMs: number;
}

interface CommandResult { message: string; type: "info" | "error" }

const USAGE = "Usage: /herdr-panes [status|enabled|disabled|auto-close <enabled|disabled|seconds>]";
const MAX_DELAY_MS = 2_147_483_647;

/** Change the current process's pane policy; no settings are written to disk. */
export function handlePaneCommand(args: string, settings: PaneSettings, manager: Pick<PaneManager, "setClosePolicy" | "setEnabled">): CommandResult {
	const words = args.trim() ? args.trim().split(/\s+/u) : [];
	if (words.length === 0 || (words.length === 1 && words[0] === "status")) {
		return { message: `herdr-panes: ${settings.enabled ? "enabled" : "disabled"}; auto-close ${settings.autoClose ? "enabled" : "disabled"}; success ${settings.closeDelayMs / 1000}s; failure ${settings.failCloseDelayMs / 1000}s (current process only)`, type: "info" };
	}
	if (words.length === 1 && (words[0] === "enabled" || words[0] === "disabled")) {
		settings.enabled = words[0] === "enabled";
		manager.setEnabled(settings.enabled);
		return { message: `herdr-panes ${settings.enabled ? "enabled" : "disabled"}; existing panes keep their close policy`, type: "info" };
	}
	if (words[0] !== "auto-close") return { message: USAGE, type: "error" };
	if (words.length === 2 && (words[1] === "enabled" || words[1] === "disabled")) {
		settings.autoClose = words[1] === "enabled";
	} else {
		const value = words.length === 2 ? words[1] : undefined;
		if (!value || !/^\d+(?:\.\d{1,3})?$/u.test(value)) {
			return { message: USAGE, type: "error" };
		}
		const [seconds, fraction = ""] = value.split(".");
		const milliseconds = Number(seconds) * 1000 + Number(fraction.padEnd(3, "0"));
		if (!Number.isSafeInteger(milliseconds) || milliseconds > MAX_DELAY_MS) {
			return { message: "Auto-close delay must be between 0 and 2147483.647 seconds (at most 3 decimal places)", type: "error" };
		}
		settings.autoClose = true;
		settings.closeDelayMs = milliseconds;
		settings.failCloseDelayMs = milliseconds;
	}
	manager.setClosePolicy(settings);
	return { message: `herdr-panes auto-close ${settings.autoClose ? "enabled" : "disabled"}; success ${settings.closeDelayMs / 1000}s; failure ${settings.failCloseDelayMs / 1000}s (current process only)`, type: "info" };
}
