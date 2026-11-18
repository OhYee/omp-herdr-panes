import { expect, test } from "bun:test";
import { readConfig } from "../src/config.ts";
import { createTernBackend, createTmuxBackend, detectPaneContext } from "../src/terminal-backend.ts";

const TERN_SESSIONS = {
	sessions: [
		{
			id: 1,
			tabs: [{ id: 2, blocks: [{ id: 10, cols: 80, rows: 24 }, { id: 20, cols: 40, rows: 24 }] }],
		},
		{ id: 3, tabs: [{ id: 4, blocks: [{ id: 30, cols: 80, rows: 24 }] }] },
	],
};

test("terminal identity prefers tmux, then legacy Herdr, then Tern", () => {
	const env = { TMUX: "/tmp/tmux/default,12345,0", TMUX_PANE: "%1", HERDR_PANE_ID: "w1:p1", TERN_PANE: "10" };
	expect(detectPaneContext(env)).toEqual({ backend: "tmux", paneId: "%1", tmuxEnv: env.TMUX });
	expect(detectPaneContext({ HERDR_PANE_ID: "w1:p1", TERN_PANE: "10" })).toEqual({ backend: "herdr", paneId: "w1:p1" });
	expect(detectPaneContext({ TERN_PANE: "10" })).toEqual({ backend: "tern", paneId: "10" });
	expect(detectPaneContext({ TMUX_PANE: "%1", TERN_PANE: "10" })).toEqual({ backend: "tern", paneId: "10" });
	expect(detectPaneContext({})).toBeNull();
	expect(readConfig({ HERDR_PANE_ID: "w1:p1" })?.mainPaneId).toBe("w1:p1");
	expect(readConfig({ TERN_PANE: "10" })?.mainPaneId).toBe("10");
});

test("Tern splits and operates only on plugin-owned blocks in the original tab", async () => {
	const calls: string[][] = [];
	const blocks = [...TERN_SESSIONS.sessions[0]!.tabs[0]!.blocks];
	const sessions = [
		{ id: 1, tabs: [{ id: 2, blocks }] },
		TERN_SESSIONS.sessions[1]!,
	];
	let nextBlock = 11;
	const backend = createTernBackend("10", async (args) => {
		calls.push(args);
		if (args[0] === "ls") return JSON.stringify({ sessions });
		if (args[0] === "split") {
			const id = nextBlock++;
			blocks.push({ id, cols: 40, rows: 12 });
			return JSON.stringify({ block: id });
		}
		if (args[0] === "run") return "";
		if (args[0] === "close") {
			const id = Number(args[1]);
			blocks.splice(blocks.findIndex((block) => block.id === id), 1);
			return "";
		}
		throw new Error(`unexpected Tern command ${args[0]}`);
	});

	const paneId = await backend.split("10", "right");
	expect(paneId).toBe("11");
	expect(calls.find((args) => args[0] === "split")).toEqual(["split", "10", "right", "--keep-open", "--json"]);
	await backend.run(paneId, "exec 'viewer' --title 'agent'");
	expect(calls.find((args) => args[0] === "run")).toEqual(["run", "11", "exec 'viewer' --title 'agent'"]);
	const callsBeforeControl = calls.length;
	await expect(backend.run(paneId, "exec viewer\nunsafe")).rejects.toMatchObject({ code: "unsafe_command" });
	expect(calls).toHaveLength(callsBeforeControl);
	expect(backend.rename).toBeUndefined();
	expect(await backend.layout("10")).toEqual([
		{ paneId: "10", rect: { x: 0, y: 0, width: 80, height: 24 } },
		{ paneId: "20", rect: { x: 0, y: 0, width: 40, height: 24 } },
		{ paneId: "11", rect: { x: 0, y: 0, width: 40, height: 12 } },
	]);
	await expect(backend.close("10")).rejects.toMatchObject({ code: "not_owned" });
	await expect(backend.close("20")).rejects.toMatchObject({ code: "not_owned" });
	await expect(backend.split("20", "right")).rejects.toMatchObject({ code: "not_owned" });
	await backend.close(paneId);
	expect(calls.find((args) => args[0] === "close")).toEqual(["close", "11", "--json"]);
	expect(blocks.map((block) => block.id)).toEqual([10, 20]);
});

test("tmux pins calls to the inherited server and preserves user panes", async () => {
	const socket = "/tmp/tmux/default";
	const serverPid = "12345";
	const calls: string[][] = [];
	const panes = [
		{ id: "%1", left: 0, top: 0, width: 80, height: 24 },
		{ id: "%2", left: 80, top: 0, width: 40, height: 24 },
	];
	let nextPane = 3;
	const backend = createTmuxBackend("%1", `${socket},${serverPid},0`, async (args) => {
		calls.push(args);
		if (args[0] !== "-S" || args[1] !== socket) throw new Error("tmux call was not pinned to the inherited server");
		switch (args[2]) {
			case "display-message": return `${serverPid}\t%1`;
			case "list-panes": return panes.map((pane) => `${pane.id}\t${pane.left}\t${pane.top}\t${pane.width}\t${pane.height}`).join("\n");
			case "split-window": {
				const id = `%${nextPane++}`;
				panes.push({ id, left: 0, top: 24, width: 80, height: 12 });
				return id;
			}
			case "send-keys":
			case "select-pane": return "";
			case "kill-pane": {
				const id = args[args.indexOf("-t") + 1];
				panes.splice(panes.findIndex((pane) => pane.id === id), 1);
				return "";
			}
			default: throw new Error(`unexpected tmux command ${args[2]}`);
		}
	});

	const paneId = await backend.split("%1", "right", 0.6);
	expect(paneId).toBe("%3");
	const split = calls.find((args) => args[2] === "split-window");
	expect(split).toContain("-d");
	expect(split).toContain("-h");
	expect(split).toContain("40%");
	await backend.run(paneId, "exec 'viewer' '; echo unsafe'");
	const typed = calls.filter((args) => args[2] === "send-keys");
	expect(typed[0]).toContain("-l");
	expect(typed[0]?.at(-1)).toBe("exec 'viewer' '; echo unsafe'");
	const callsBeforeControl = calls.length;
	await expect(backend.run(paneId, "exec viewer\nunsafe")).rejects.toMatchObject({ code: "unsafe_command" });
	expect(calls).toHaveLength(callsBeforeControl);
	expect(typed[1]?.at(-1)).toBe("Enter");
	await backend.rename!(paneId, "agent ; untouched");
	expect(calls.find((args) => args[2] === "select-pane")).toContain("agent ; untouched");
	expect(await backend.layout("%1")).toEqual([
		{ paneId: "%1", rect: { x: 0, y: 0, width: 80, height: 24 } },
		{ paneId: "%2", rect: { x: 80, y: 0, width: 40, height: 24 } },
		{ paneId: "%3", rect: { x: 0, y: 24, width: 80, height: 12 } },
	]);
	await expect(backend.close("%1")).rejects.toMatchObject({ code: "not_owned" });
	await expect(backend.split("%2", "right", 0.5)).rejects.toMatchObject({ code: "not_owned" });
	await expect(backend.close("%2")).rejects.toMatchObject({ code: "not_owned" });
	await backend.close(paneId);
	expect(calls.filter((args) => args[2] === "kill-pane")).toEqual([["-S", socket, "kill-pane", "-t", "%3"]]);
	expect(panes.map((pane) => pane.id)).toEqual(["%1", "%2"]);
});

test("malformed tmux server identity fails closed before executing commands", () => {
	expect(() => createTmuxBackend("%1", "not-a-server")).toThrow();
});

test("a different tmux server identity blocks all pane operations", async () => {
	const calls: string[][] = [];
	const backend = createTmuxBackend("%1", "/tmp/tmux/default,12345,0", async (args) => {
		calls.push(args);
		return "54321\t%1";
	});

	await expect(backend.layout("%1")).rejects.toMatchObject({ code: "server_changed" });
	expect(calls).toHaveLength(1);
	expect(calls[0]?.[2]).toBe("display-message");
});

test("Tern closes owned blocks in the original tab after the root block disappears", async () => {
	const calls: string[][] = [];
	const blocks = [{ id: 10, cols: 80, rows: 24 }, { id: 20, cols: 40, rows: 24 }];
	const backend = createTernBackend("10", async (args) => {
		calls.push(args);
		if (args[0] === "ls") return JSON.stringify({ sessions: [{ id: 1, tabs: [{ id: 2, blocks }] }] });
		if (args[0] === "split") {
			blocks.push({ id: 11, cols: 40, rows: 24 });
			return JSON.stringify({ block: 11 });
		}
		if (args[0] === "close") {
			blocks.splice(blocks.findIndex((block) => String(block.id) === args[1]), 1);
			return "";
		}
		throw new Error(`unexpected command ${args[0]}`);
	});
	const child = await backend.split("10", "right");
	blocks.splice(blocks.findIndex((block) => block.id === 10), 1);
	await expect(backend.run(child, "exec viewer")).rejects.toMatchObject({ code: "pane_not_found" });
	await backend.close(child);
	expect(blocks.map((block) => block.id)).toEqual([20]);
	expect(calls.filter((args) => args[0] === "close")).toEqual([["close", "11", "--json"]]);
	await expect(backend.close("20")).rejects.toMatchObject({ code: "not_owned" });
});

test("tmux falls back to an owned pane after the root disappears and still pins the server", async () => {
	const socket = "/tmp/tmux/isolated";
	const calls: string[][] = [];
	const ids = new Set(["%1", "%2"]);
	let pid = "12345";
	const backend = createTmuxBackend("%1", `${socket},12345,0`, async (args) => {
		calls.push(args);
		const command = args[2];
		const target = args[args.indexOf("-t") + 1];
		if (command === "display-message") {
			if (!target || !ids.has(target)) throw new Error("pane missing");
			return `${pid}\t${target}`;
		}
		if (command === "list-panes") return [...ids].map((id) => `${id}\t0\t0\t80\t24`).join("\n");
		if (command === "split-window") { ids.add("%3"); return "%3"; }
		if (command === "kill-pane") { if (target) ids.delete(target); return ""; }
		throw new Error(`unexpected command ${command}`);
	});
	const child = await backend.split("%1", "right", 0.6);
	ids.delete("%1");
	pid = "99999";
	await expect(backend.close(child)).rejects.toMatchObject({ code: "server_changed" });
	expect(ids.has(child)).toBe(true);
	pid = "12345";
	await backend.close(child);
	expect([...ids]).toEqual(["%2"]);
	expect(calls.filter((args) => args[2] === "kill-pane")).toEqual([["-S", socket, "kill-pane", "-t", "%3"]]);
	await expect(backend.close("%2")).rejects.toMatchObject({ code: "not_owned" });
});

test("tmux closes only the inherited current pane after validating its server", async () => {
	const calls: string[][] = [];
	const backend = createTmuxBackend("%7", "/tmp/tmux/isolated,12345,0", async (args) => {
		calls.push(args);
		if (args[2] === "display-message") return "12345\t%7";
		if (args[2] === "list-panes") return "%7\t0\t0\t80\t24\n%8\t81\t0\t80\t24";
		if (args[2] === "kill-pane") return "";
		throw new Error(`unexpected command ${args[2]}`);
	});
	await backend.closeCurrent!();
	expect(calls.filter((args) => args[2] === "kill-pane")).toEqual([["-S", "/tmp/tmux/isolated", "kill-pane", "-t", "%7"]]);
});

test("tmux current-pane cleanup refuses a changed server identity", async () => {
	const calls: string[][] = [];
	const backend = createTmuxBackend("%7", "/tmp/tmux/isolated,12345,0", async (args) => {
		calls.push(args);
		return "54321\t%7";
	});
	await expect(backend.closeCurrent!()).rejects.toMatchObject({ code: "server_changed" });
	expect(calls.some((args) => args[2] === "kill-pane")).toBe(false);
});
