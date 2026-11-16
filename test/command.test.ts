import { expect, test } from "bun:test";
import { completePaneCommand, handlePaneCommand, type PaneSettings } from "../src/command.ts";
import type { PaneManagerConfig } from "../src/pane-manager.ts";

function fixture() {
	const settings: PaneSettings = { enabled: true, autoClose: true, closeDelayMs: 3000, failCloseDelayMs: 10000 };
	const applied: Array<Pick<PaneManagerConfig, "autoClose" | "closeDelayMs" | "failCloseDelayMs">> = [];
	const manager = {
		setClosePolicy: (policy: Pick<PaneManagerConfig, "autoClose" | "closeDelayMs" | "failCloseDelayMs">) => applied.push({ ...policy }),
		setEnabled: (_enabled: boolean) => {},
	};
	return { settings, applied, run: (args: string) => handlePaneCommand(args, settings, manager) };
}

test("status and pane enablement do not change automatic close policy", () => {
	const h = fixture();
	expect(h.run("").message).toContain("success 3s; failure 10s");
	h.run("disabled");
	expect(h.settings.enabled).toBe(false);
	expect(h.settings.autoClose).toBe(true);
	h.run("enabled");
	expect(h.settings.enabled).toBe(true);
	expect(h.applied).toEqual([]);
});

test("auto-close command applies the same delay to both outcomes", () => {
	const h = fixture();
	h.run("auto-close disabled");
	expect(h.settings.autoClose).toBe(false);
	h.run("auto-close 5");
	expect(h.settings).toEqual({ enabled: true, autoClose: true, closeDelayMs: 5000, failCloseDelayMs: 5000 });
	h.run("auto-close 1.001");
	expect(h.settings.closeDelayMs).toBe(1001);
	expect(h.settings.failCloseDelayMs).toBe(1001);
	h.run("auto-close 0");
	expect(h.settings.closeDelayMs).toBe(0);
	expect(h.applied.at(-1)?.failCloseDelayMs).toBe(0);
	h.run("auto-close disabled");
	h.run("auto-close enabled");
	expect(h.settings.autoClose).toBe(true);
	expect(h.settings.closeDelayMs).toBe(0);
});

test("malformed and out-of-range commands cannot mutate settings", () => {
	const h = fixture();
	const original = { ...h.settings };
	for (const args of ["enabled extra", "auto-close", "auto-close -1", "auto-close 1.0001", "auto-close 2147483.648", "auto-close success 5", "auto-close failure 10", "auto-close 1 2"]) {
		expect(h.run(args).type).toBe("error");
		expect(h.settings).toEqual(original);
	}
	expect(h.applied).toEqual([]);
});

test("command completion discovers options and completes auto-close arguments", () => {
	expect(completePaneCommand("")?.map((item) => item.value)).toEqual(["status", "enabled", "disabled", "auto-close"]);
	expect(completePaneCommand("en")?.map((item) => item.value)).toEqual(["enabled"]);
	expect(completePaneCommand("auto-close ")?.map((item) => item.value)).toEqual(["auto-close enabled", "auto-close disabled"]);
	expect(completePaneCommand("auto-close  dis")?.map((item) => item.value)).toEqual(["auto-close  disabled"]);
	expect(completePaneCommand("auto-close 5")).toBeNull();
	expect(completePaneCommand("disabled extra")).toBeNull();
	expect(fixture().run("").message).toContain("Usage: /herdr-panes");
});
