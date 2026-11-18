import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionTree } from "../src/session-tree.ts";
import { PaneManager, type Schedule } from "../src/pane-manager.ts";
import type { Herdr, LayoutPane } from "../src/herdr.ts";

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "omp-session-tree-"));
	const root = join(dir, "root.jsonl");
	const children = join(dir, "root");
	mkdirSync(children);
	writeFileSync(root, `${JSON.stringify({ type: "session", id: "root" })}\n`);
	const opened: Array<{ file: string; label: string; parent?: string }> = [];
	const finished: Array<{ file: string; status: string }> = [];
	const active = new Set<string>();
	const panes = {
		open(file: string, label: string, parent?: string): Promise<void> {
			if (!active.has(file)) opened.push({ file, label, parent });
			active.add(file);
			return Promise.resolve();
		},
		finish(file: string, status: string): void {
			if (active.has(file)) finished.push({ file, status });
		},
		has(file: string): boolean { return active.has(file); },
		isWaiting(): boolean { return false; },
	};
	const tree = new SessionTree(root, panes);
	const session = (file: string, parent: string): void => {
		writeFileSync(file, `${JSON.stringify({ type: "title", title: "" })}\n${JSON.stringify({ type: "session", id: "id", parentSession: parent })}\n`);
	};
	return { dir, root, children, opened, finished, active, panes, tree, session };
}

test("discovers task descendants but ignores same-directory branches and symlinks", async () => {
	const f = fixture();
	try {
		const a = join(f.children, "A.jsonl");
		const b = join(f.children, "B.jsonl");
		const nested = join(f.children, "A");
		mkdirSync(nested);
		const grandchild = join(nested, "A.Inner.jsonl");
		f.session(a, f.root);
		f.session(b, f.root);
		f.session(grandchild, a);
		f.session(join(f.children, "other.jsonl"), join(f.dir, "other-root.jsonl"));
		const outside = join(f.dir, "outside.jsonl");
		f.session(outside, f.root);
		symlinkSync(outside, join(f.children, "link.jsonl"));
		await Promise.all([f.tree.scan(), f.tree.scan()]);
		expect(f.opened).toContainEqual({ file: a, label: "A", parent: undefined });
		expect(f.opened).toContainEqual({ file: b, label: "B", parent: undefined });
		expect(f.opened).toContainEqual({ file: grandchild, label: "A.Inner", parent: a });
		expect(f.opened.map((item) => item.file)).not.toContain(outside);
		expect(f.opened).toHaveLength(3);
	} finally { f.tree.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("deduplicates lifecycle and scans while retrying a late, incomplete transcript", async () => {
	const f = fixture();
	try {
		const child = join(f.children, "child.jsonl");
		f.tree.started(child, "named · task");
		f.tree.started(child, "named · task");
		await f.tree.scan();
		expect(f.opened).toEqual([]);
		writeFileSync(child, '{"type":"session","parentSession":');
		await f.tree.scan();
		expect(f.opened).toEqual([]);
		f.tree.finished(child, "completed");
		f.session(child, f.root);
		await f.tree.scan();
		await f.tree.scan();
		expect(f.opened).toEqual([{ file: child, label: "named · task", parent: undefined }]);
		expect(f.finished).toEqual([{ file: child, status: "completed" }]);
	} finally { f.tree.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("does not discover children of a closed parent or open after tree cleanup", async () => {
	const f = fixture();
	try {
		const parent = join(f.children, "parent.jsonl");
		f.session(parent, f.root);
		await f.tree.scan();
		f.active.delete(parent);
		const nested = join(f.children, "parent");
		mkdirSync(nested);
		const child = join(nested, "child.jsonl");
		f.session(child, parent);
		await f.tree.scan();
		expect(f.opened.map((item) => item.file)).toEqual([parent]);
		const scanning = f.tree.scan();
		f.tree.close();
		await scanning;
		expect(f.opened.map((item) => item.file)).toEqual([parent]);
	} finally { f.tree.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("active-only discovery retries disabled and failed opens without reviving history", async () => {
	const f = fixture();
	const opened: string[] = [];
	const active = new Set<string>();
	let enabled = false;
	let failNext = true;
	const panes = {
		async open(file: string): Promise<void> {
			if (!enabled) return;
			if (failNext) { failNext = false; return; }
			opened.push(file);
			active.add(file);
		},
		finish(file: string): void { active.delete(file); },
		has(file: string): boolean { return active.has(file); },
		isWaiting(): boolean { return false; },
	};
	const tree = new SessionTree(f.root, panes, () => {}, "active");
	try {
		const historical = join(f.children, "historical.jsonl");
		const running = join(f.children, "running.jsonl");
		const finished = join(f.children, "finished.jsonl");
		f.session(historical, f.root);
		f.session(running, f.root);
		f.session(finished, f.root);
		tree.started(running, "running");
		tree.started(finished, "finished");
		tree.finished(finished, "completed", Date.now(), false);
		await tree.scan();
		expect(opened).toEqual([]);
		enabled = true;
		await tree.scan();
		expect(opened).toEqual([]);
		await tree.scan();
		expect(opened).toEqual([running]);
		active.delete(running);
		await tree.scan();
		expect(opened).toEqual([running]);
	} finally {
		tree.close();
		f.tree.close();
		rmSync(f.dir, { recursive: true, force: true });
	}
});

test("an observed completed task still opens when its transcript appears late", async () => {
	const f = fixture();
	const tree = new SessionTree(f.root, f.panes, () => {}, "active");
	try {
		const late = join(f.children, "late.jsonl");
		tree.started(late, "late · task");
		tree.finished(late, "completed", 1000, true);
		await tree.scan();
		expect(f.opened).toEqual([]);
		f.session(late, f.root);
		await tree.scan();
		expect(f.opened).toEqual([{ file: late, label: "late · task", parent: undefined }]);
		expect(f.finished).toEqual([{ file: late, status: "completed" }]);
	} finally {
		tree.close();
		f.tree.close();
		rmSync(f.dir, { recursive: true, force: true });
	}
});

test("reviving a parent cancels its close while another pane is still opening", async () => {
	const f = fixture();
	const a = join(f.children, "A.jsonl");
	const a1 = join(f.children, "A", "A1.jsonl");
	const b = join(f.children, "B.jsonl");
	const layout: LayoutPane[] = [{ paneId: "root-pane", rect: { x: 0, y: 0, width: 80, height: 40 } }];
	const closed: string[] = [];
	const splitStarted = Promise.withResolvers<void>();
	const resumeSplit = Promise.withResolvers<void>();
	const timers: Array<{ ms: number; cancelled: boolean; fire(): void }> = [];
	const schedule: Schedule = (fn, ms) => {
		const timer = { ms, cancelled: false, fire: fn };
		timers.push(timer);
		return { cancel: () => { timer.cancelled = true; } };
	};
	let next = 1;
	const backend: Herdr = {
		async split() {
			const number = next++;
			if (number === 3) { splitStarted.resolve(); await resumeSplit.promise; }
			const paneId = `pane-${number}`;
			layout.push({ paneId, rect: { x: 0, y: 0, width: 40, height: 40 } });
			return paneId;
		},
		async run() {},
		async rename() {},
		async close(paneId) { closed.push(paneId); },
		async layout() { return layout; },
	};
	const panes = new PaneManager(backend, {
		mainPaneId: "root-pane", ratio: 0.6, maxPanes: 4, closeDelayMs: 987, failCloseDelayMs: 1987,
		viewerCommand: () => "viewer",
	}, () => {}, schedule);
	const tree = new SessionTree(f.root, panes, () => {}, "active");
	try {
		mkdirSync(join(f.children, "A"));
		f.session(a, f.root); f.session(a1, a); f.session(b, f.root);
		tree.started(a, "A"); tree.started(a1, "A1");
		await tree.scan();
		expect(panes.has(a)).toBe(true);
		expect(panes.has(a1)).toBe(true);
		tree.finished(a, "completed");
		const closeTimer = timers.find((timer) => timer.ms <= 987);
		expect(closeTimer).toBeDefined();
		tree.started(b, "B");
		await splitStarted.promise;
		tree.started(a, "A revived");
		expect(closeTimer!.cancelled).toBe(true);
		closeTimer!.fire();
		resumeSplit.resolve();
		await tree.scan();
		expect(closed).toEqual([]);
		expect(panes.has(a)).toBe(true);
		expect(panes.has(a1)).toBe(true);
	} finally {
		resumeSplit.resolve();
		tree.close();
		await panes.closeAll();
		f.tree.close();
		rmSync(f.dir, { recursive: true, force: true });
	}
});

test("a late completed transcript is dropped at capacity but opens when a slot is free", async () => {
	const f = fixture();
	const blocked = join(f.children, "blocked.jsonl");
	const available = join(f.children, "available.jsonl");
	const active = new Set(["occupied"]);
	const waiting = new Set<string>();
	const opened: string[] = [];
	const finished: string[] = [];
	const panes = {
		async open(file: string): Promise<void> {
			if (active.size >= 1) { waiting.add(file); return; }
			active.add(file);
			opened.push(file);
		},
		finish(file: string): void {
			waiting.delete(file);
			if (active.has(file)) finished.push(file);
		},
		has(file: string): boolean { return active.has(file); },
		isWaiting(file: string): boolean { return waiting.has(file); },
	};
	const tree = new SessionTree(f.root, panes, () => {}, "active");
	try {
		tree.started(blocked, "blocked");
		tree.finished(blocked, "completed");
		await tree.scan();
		f.session(blocked, f.root);
		await tree.scan();
		expect(waiting.has(blocked)).toBe(false);
		active.delete("occupied");
		await tree.scan();
		expect(opened).toEqual([]);

		tree.started(available, "available");
		tree.finished(available, "completed");
		await tree.scan();
		f.session(available, f.root);
		await tree.scan();
		expect(opened).toEqual([available]);
		expect(finished).toEqual([available]);
	} finally {
		tree.close();
		f.tree.close();
		rmSync(f.dir, { recursive: true, force: true });
	}
});
