import { readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { PaneManager } from "./pane-manager.ts";
import { recordOf } from "./render.ts";

const SCAN_INTERVAL_MS = 1000;
const HEADER_LIMIT = 128 * 1024;

type TreePanes = Pick<PaneManager, "open" | "finish" | "has" | "isWaiting">;
type RuntimeSession = { label: string; status?: string; finishedAt?: number; openIfFinished?: boolean; queuedBeforeOpen?: boolean };

/** Discover direct children from session headers, including files created after their lifecycle event. */
export class SessionTree {
	readonly root: string;
	private readonly parents = new Map<string, string>();
	private readonly headers = new Map<string, string | null>();
	private readonly runtime = new Map<string, RuntimeSession>();
	private timer?: NodeJS.Timeout;
	private running?: Promise<void>;
	private wakePending = false;
	private closed = false;

	constructor(root: string, private readonly panes: TreePanes, private readonly log: (error: unknown) => void = () => {}, private readonly mode: "history" | "active" = "history") {
		this.root = resolve(root);
	}

	start(): void {
		if (this.closed || this.timer) return;
		this.timer = setInterval(() => { void this.scan(); }, SCAN_INTERVAL_MS);
		this.timer.unref();
		void this.scan();
	}

	started(file: string, label: string): void {
		if (this.closed) return;
		const key = resolve(file);
		const previous = this.runtime.get(key);
		if (previous && previous.status === undefined) {
			previous.label = label;
			return;
		}
		const parent = this.parents.get(key) ?? this.headers.get(key);
		if (previous?.status !== undefined && typeof parent === "string" && this.panes.has(key)) {
			this.runtime.set(key, { label });
			void this.panes.open(key, label, parent === this.root ? undefined : parent);
			void this.scan();
			return;
		}
		if (previous?.status !== undefined) this.parents.delete(key);
		this.runtime.set(key, { label });
		void this.scan();
	}

	finished(file: string, status: string, finishedAt = Date.now(), openIfFinished = true): void {
		if (this.closed) return;
		const key = resolve(file);
		const previous = this.runtime.get(key);
		if (!previous && this.mode === "active") return;
		const current = previous ?? { label: basename(key, ".jsonl") };
		if (current.status === undefined) {
			current.openIfFinished = openIfFinished && (this.panes.has(key) || !(current.queuedBeforeOpen || this.panes.isWaiting(key)));
		}
		current.status = status;
		current.finishedAt ??= finishedAt;
		this.runtime.set(key, current);
		this.panes.finish(key, status, current.finishedAt);
		void this.scan();
	}

	/** Coalesce notifications with the periodic scan; callers can await a complete pass. */
	scan(): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.running) {
			this.wakePending = true;
			return this.running;
		}
		this.running = (async () => {
			try {
				do {
					this.wakePending = false;
					await this.scanOnce();
				} while (!this.closed && this.wakePending);
			} catch (error) {
				this.log(error);
			} finally {
				this.running = undefined;
			}
		})();
		return this.running;
	}

	close(): void {
		this.closed = true;
		clearInterval(this.timer);
		this.timer = undefined;
		this.runtime.clear();
		this.parents.clear();
		this.headers.clear();
	}

	private async scanOnce(): Promise<void> {
		const visited = new Set<string>();
		const parents = [this.root];
		for (let index = 0; index < parents.length && !this.closed; index++) {
			const parent = parents[index]!;
			if (parent !== this.root && !this.panes.has(parent)) continue;
			const candidates = new Set(this.runtime.keys());
			if (this.mode === "history") {
				const dir = parent.endsWith(".jsonl") ? parent.slice(0, -6) : parent;
				try {
					const entries = await readdir(dir, { withFileTypes: true });
					for (const entry of entries) {
						if (entry.isFile() && entry.name.endsWith(".jsonl")) candidates.add(join(dir, entry.name));
					}
				} catch { /* The child directory may not exist yet. */ }
			}
			for (const file of candidates) {
				if (this.closed) return;
				if (file === this.root || visited.has(file)) continue;
				let actualParent = this.headers.get(file);
				if (actualParent === undefined) {
					actualParent = await readParent(file);
					if (this.closed) return;
					if (actualParent !== undefined) this.headers.set(file, actualParent);
				}
				if (actualParent !== parent) continue;
				visited.add(file);
				if (!this.parents.has(file)) {
					let runtime = this.runtime.get(file);
					if (this.mode === "active" && !runtime) continue;
					if (runtime?.status !== undefined && runtime.openIfFinished === false) continue;
					await this.panes.open(file, runtime?.label ?? basename(file, ".jsonl"), parent === this.root ? undefined : parent);
					if (this.closed) return;
					runtime = this.runtime.get(file);
					if (!this.panes.has(file)) {
						if (runtime && this.panes.isWaiting(file)) {
							runtime.queuedBeforeOpen = true;
							if (runtime.status !== undefined) {
								runtime.openIfFinished = false;
								this.panes.finish(file, runtime.status, runtime.finishedAt);
							}
						}
						continue;
					}
					this.parents.set(file, parent);
					runtime = this.runtime.get(file);
					if (runtime?.status !== undefined) this.panes.finish(file, runtime.status, runtime.finishedAt);
				}
				if (this.panes.has(file)) parents.push(file);
			}
		}
	}
}

async function readParent(file: string): Promise<string | null | undefined> {
	try {
		const text = await Bun.file(file).slice(0, HEADER_LIMIT).text();
		for (const line of text.split("\n")) {
			try {
				const header = recordOf(JSON.parse(line));
				if (header?.["type"] !== "session") continue;
				const parent = header["parentSession"];
				return typeof parent === "string" && parent.length > 0 ? resolve(dirname(file), parent) : null;
			} catch { /* The header may not have been fully written yet. */ }
		}
	} catch { /* A lifecycle event can precede creation of its transcript. */ }
	return undefined;
}
