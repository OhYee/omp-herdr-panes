import { expect, test } from "bun:test";
import { PaneManager } from "../src/pane-manager.ts";
import { createTernBackend } from "../src/terminal-backend.ts";

function ternFixture(runFails = false) {
	const calls: string[][] = [];
	const blocks = [{ id: 10, cols: 80, rows: 30 }];
	let nextBlock = 11;
	const backend = createTernBackend("10", async (args) => {
		calls.push(args);
		if (args[0] === "ls") return JSON.stringify({ sessions: [{ id: 1, tabs: [{ id: 2, blocks }] }] });
		if (args[0] === "split") {
			const id = nextBlock++;
			blocks.push({ id, cols: args[2] === "right" ? 40 : 80, rows: args[2] === "right" ? 30 : 15 });
			return JSON.stringify({ block: id });
		}
		if (args[0] === "run") {
			if (runFails) throw new Error("viewer launch failed");
			return "";
		}
		if (args[0] === "close") {
			const id = Number(args[1]);
			blocks.splice(blocks.findIndex((block) => block.id === id), 1);
			return "";
		}
		throw new Error(`unexpected Tern command ${args[0]}`);
	});
	const logs: string[] = [];
	const manager = new PaneManager(backend, {
		mainPaneId: "10",
		ratio: 0.6,
		maxPanes: 4,
		autoClose: false,
		closeDelayMs: 1000,
		failCloseDelayMs: 5000,
		viewerCommand: (_sessionFile, label) => `exec viewer --title '${label}'`,
	}, (message) => logs.push(message));
	return { blocks, calls, logs, manager };
}

test("Tern lifecycle creates viewers without pretending to set ratios or pane names", async () => {
	const h = ternFixture();
	await h.manager.open("/tmp/one.jsonl", "agent one");
	await h.manager.open("/tmp/two.jsonl", "agent two");

	expect(h.calls.filter((args) => args[0] === "split")).toEqual([
		["split", "10", "right", "--keep-open", "--json"],
		["split", "11", "down", "--keep-open", "--json"],
	]);
	expect(h.calls.filter((args) => args[0] === "run")).toEqual([
		["run", "11", "exec viewer --title 'agent one'"],
		["run", "12", "exec viewer --title 'agent two'"],
	]);
	expect(h.logs).toContain("pane backend does not support configured split ratios; native split sizes will be used");
	expect(h.logs).toContain("pane backend does not support pane renaming; the viewer title is set at launch");
	await h.manager.closeAll();
	expect(h.calls.filter((args) => args[0] === "close").map((args) => args[1])).toEqual(["11", "12"]);
	expect(h.blocks.map((block) => block.id)).toEqual([10]);
});

test("a failed viewer launch closes only its created Tern block, once during shutdown", async () => {
	const h = ternFixture(true);
	const opening = h.manager.open("/tmp/failure.jsonl", "agent failed");
	const closing = h.manager.closeAll();
	await Promise.all([opening, closing]);

	expect(h.manager.size).toBe(0);
	expect(h.calls.filter((args) => args[0] === "close").map((args) => args[1])).toEqual(["11"]);
	expect(h.blocks.map((block) => block.id)).toEqual([10]);
	expect(h.logs).toContain("pane run failed");
	expect(h.logs).not.toContain("pane close failed");
});

test("Tern keeps nested children beside their parent when positions are unavailable", async () => {
	const h = ternFixture();
	await h.manager.open("/tmp/A.jsonl", "A");
	await h.manager.open("/tmp/A1.jsonl", "A1", "/tmp/A.jsonl");
	await h.manager.open("/tmp/A2.jsonl", "A2", "/tmp/A.jsonl");
	expect(h.calls.filter((args) => args[0] === "split")).toEqual([
		["split", "10", "right", "--keep-open", "--json"],
		["split", "11", "right", "--keep-open", "--json"],
		["split", "11", "right", "--keep-open", "--json"],
	]);
	await h.manager.closeAll();
});
