/**
 * Pane manager: one viewer pane per subagent, grouped to the right of its parent.
 *
 * Backend interactions share one promise chain so concurrent splits cannot interleave. The tracked
 * map (key = the subagent's sessionFile) is mutated synchronously, so a terminal status that arrives
 * before a split completes is not lost.
 * Nothing here rejects or throws at its caller: backend failures are logged and skipped, because an
 * exception escaping an extension callback would take down the whole omp session.
 */

import { HerdrError } from "./herdr.ts";
import type { LayoutPane } from "./herdr.ts";
import type { PaneBackend } from "./terminal-backend.ts";

export interface PaneManagerConfig {
	/** Pane running omp; the stack is created to its right. */
	mainPaneId: string;
	/** Width share kept by the main pane on the first split when supported by the backend. */
	ratio: number;
	/** Max simultaneously open subagent panes; extra subagents wait in FIFO order for a slot. */
	maxPanes: number;
	/** Disable automatic closing and eviction when false; defaults to true. */
	autoClose?: boolean;
	/** Delay between a `completed` finish() and closing the pane. */
	closeDelayMs: number;
	/** Delay between any other (failed, aborted, …) finish() and closing the pane. */
	failCloseDelayMs: number;
	/** Reconcile manually closed viewers even when no work is waiting. */
	monitorPanes?: boolean;
	/** Shell command typed into a new pane. */
	viewerCommand(sessionFile: string, label: string, paneId: string): string;
}

export type Log = (message: string, context?: Record<string, unknown>) => void;
export type Schedule = (fn: () => void, ms: number) => { cancel(): void };

interface Entry {
	key: string;
	label: string;
	/** Undefined means the original pane, otherwise the key of the parent viewer. */
	parentKey?: string;
	paneId?: string;
	/** Open order, monotonically increasing; breaks height ties when picking the split target. */
	order: number;
	done: boolean;
	/** Terminal lifecycle status (`completed`, `failed`, `aborted`, …) once done. */
	status?: string;
	finishedAt?: number;
	closeGeneration?: number;
	timer?: { cancel(): void };
}

/** Share of the split pane that a newly stacked pane keeps (the rest stays with the target). */
const STACK_SPLIT_RATIO = 0.5;
/** Poll only while work is waiting for a manually closed pane. */
const RECONCILE_DELAY_MS = 1000;

export class PaneManager {
	readonly #backend: PaneBackend;
	readonly #config: PaneManagerConfig;
	readonly #logger: Log;
	readonly #schedule: Schedule;
	readonly #now: () => number;
	readonly #entries = new Map<string, Entry>();
	/** Subagents waiting for a slot or for their parent to open, in arrival order. */
	readonly #waiting = new Map<string, { label: string; parentKey?: string }>();
	/** Tail of the serialized backend job chain. Never rejects. */
	#queue: Promise<void> = Promise.resolve();
	#nextOrder = 0;
	#reconcileTimer?: { cancel(): void };
	#reconcileGeneration = 0;
	#enabled = true;

	constructor(backend: PaneBackend, config: PaneManagerConfig, log: Log, schedule?: Schedule, now: () => number = Date.now) {
		this.#backend = backend;
		this.#config = config;
		this.#logger = log;
		this.#now = now;
		this.#schedule =
			schedule ??
			defaultSchedule((message, context) => {
				this.#log(message, context);
			});
		if (backend.supportsRatio === false) {
			this.#log("pane backend does not support configured split ratios; native split sizes will be used");
		}
		if (backend.rename === undefined) {
			this.#log("pane backend does not support pane renaming; the viewer title is set at launch");
		}
	}

	/**
	 * Open a pane for this subagent. A parent key names another viewer; without it the parent is
	 * the original pane. Resolves when queued backend calls finish and never rejects.
	 */
	open(key: string, label: string, parentKey?: string): Promise<void> {
		const existing = this.#entries.get(key);
		if (existing !== undefined) {
			// A repeated `started` event revives the subagent: drop the pending close, keep its pane.
			this.#cancelTimer(existing);
			existing.closeGeneration = (existing.closeGeneration ?? 0) + 1;
			existing.done = false;
			existing.finishedAt = undefined;
			if (existing.status !== undefined) {
				existing.status = undefined;
				const paneId = existing.paneId;
				if (paneId !== undefined) void this.#enqueue(() => this.#rename(key, paneId, existing));
			}
			return this.#queue;
		}
		if (!this.#enabled || key === parentKey) return Promise.resolve();
		if (this.#waiting.has(key)) return Promise.resolve();
		if (parentKey !== undefined && !this.#entries.has(parentKey) && !this.#waiting.has(parentKey)) return Promise.resolve();
		if (this.#entries.size >= this.#config.maxPanes || (parentKey !== undefined && !this.#entries.has(parentKey))) {
			this.#log("pane limit reached, waiting for a free slot", { key });
			this.#waiting.set(key, { label, parentKey });
			this.#scheduleReconcile();
			return Promise.resolve();
		}
		// Insert before enqueuing, so a finish() arriving while the backend is still working is not lost.
		const entry: Entry = { key, label, parentKey, order: this.#nextOrder, done: false };
		this.#nextOrder += 1;
		this.#entries.set(key, entry);
		this.#scheduleReconcile();
		return this.#enqueue(() => this.#openPane(key, entry));
	}

	/**
	 * The subagent reached a terminal `status`: mark its pane title when supported and close it after
	 * closeDelayMs (`completed`) or failCloseDelayMs (anything else). Never throws.
	 */
	finish(key: string, status: string, finishedAt = this.#now()): void {
		if (this.#waiting.delete(key)) {
			const removed = new Set([key]);
			let changed = true;
			while (changed) {
				changed = false;
				for (const [child, request] of this.#waiting) {
					if (request.parentKey !== undefined && removed.has(request.parentKey)) {
						this.#waiting.delete(child);
						removed.add(child);
						changed = true;
					}
				}
			}
			if (!this.#needsReconcile()) this.#cancelReconcile();
			return;
		}
		const entry = this.#entries.get(key);
		if (entry === undefined) return;
		if (!entry.done) entry.finishedAt = finishedAt;
		entry.done = true;
		entry.status = status;
		// No pane yet: open's job applies the title when available and schedules close after split.
		const paneId = entry.paneId;
		if (paneId === undefined) return;
		void this.#enqueue(() => this.#rename(key, paneId, entry));
		this.#scheduleClose(key, entry);
	}

	/** Apply a runtime close policy to already-finished and future panes. */
	setClosePolicy(policy: Pick<PaneManagerConfig, "autoClose" | "closeDelayMs" | "failCloseDelayMs">): void {
		this.#config.autoClose = policy.autoClose;
		this.#config.closeDelayMs = policy.closeDelayMs;
		this.#config.failCloseDelayMs = policy.failCloseDelayMs;
		for (const [key, entry] of this.#entries) {
			if (!entry.done) continue;
			this.#cancelTimer(entry);
			entry.closeGeneration = (entry.closeGeneration ?? 0) + 1;
			if (entry.paneId !== undefined) this.#scheduleClose(key, entry);
		}
		if (this.#needsReconcile()) this.#scheduleReconcile();
		else this.#cancelReconcile();
	}

	/** Disable new panes without closing panes that already exist. */
	setEnabled(enabled: boolean): void {
		this.#enabled = enabled;
		if (!enabled) {
			this.#waiting.clear();
			if (!this.#needsReconcile()) this.#cancelReconcile();
		}
	}

	has(key: string): boolean {
		return this.#entries.has(key);
	}

	isWaiting(key: string): boolean {
		return this.#waiting.has(key);
	}

	/** Close every pane now and cancel pending timers. Never rejects. */
	async closeAll(): Promise<void> {
		this.#cancelReconcile();
		const closing = [...this.#entries];
		for (const [, entry] of closing) this.#cancelTimer(entry);
		// Forgotten right away: a pane opened from here on belongs to a new subagent.
		this.#entries.clear();
		this.#waiting.clear();
		await this.#enqueue(async () => {
			for (const [key, entry] of closing) {
				// Set late by an open job queued ahead of this one, hence read at run time.
				const paneId = entry.paneId;
				if (paneId === undefined) continue;
				if (await this.#closePane(paneId, key)) entry.paneId = undefined;
			}
		});
	}

	/** Number of subagents currently tracked (opening, open, or waiting to close). For tests. */
	get size(): number {
		return this.#entries.size;
	}

	/**
	 * Appends a job to the serialized backend chain. Jobs run strictly one after another; a failing
	 * job logs and the chain continues, so one broken pane cannot stall the others.
	 */
	#enqueue(job: () => Promise<void>): Promise<void> {
		const queued = this.#queue.then(async () => {
			try {
				await job();
			} catch (error) {
				this.#log("pane backend job failed", { error: describeError(error) });
			}
		});
		this.#queue = queued;
		return queued;
	}

	/** The queued half of open(): pick a split target, create the pane, start the viewer. */
	async #openPane(key: string, entry: Entry): Promise<void> {
		if (entry.parentKey !== undefined && this.#entries.get(key) !== entry) return;
		let paneId: string;
		try {
			paneId = await this.#splitFor(key, entry);
		} catch (error) {
			this.#log("pane split failed", { key, error: describeError(error) });
			if (this.#entries.get(key) === entry) {
				await this.#removeSubtree(key);
				this.#promote();
			}
			return;
		}
		entry.paneId = paneId;
		if (entry.parentKey !== undefined && this.#entries.get(key) !== entry) return;
		if (entry.parentKey !== undefined) {
			let parentPresent: boolean;
			try {
				const parentPane = this.#entries.get(entry.parentKey)?.paneId;
				parentPresent = parentPane !== undefined && (await this.#backend.layout(this.#config.mainPaneId))
					.some((pane) => pane.paneId === parentPane);
			} catch (error) {
				this.#log("pane layout failed", { key, error: describeError(error) });
				if (this.#entries.get(key) === entry) {
					await this.#removeSubtree(key);
					this.#promote();
				}
				return;
			}
			if (this.#entries.get(key) !== entry) return;
			if (!parentPresent) {
				await this.#removeSubtree(entry.parentKey);
				this.#promote();
				return;
			}
		}
		await this.#rename(key, paneId, entry);
		if (entry.parentKey !== undefined && this.#entries.get(key) !== entry) return;
		try {
			const command = this.#config.viewerCommand(key, entry.label, paneId);
			if (/[\u0000-\u001f\u007f-\u009f]/u.test(command)) throw new Error("viewer command contains terminal control characters");
			await this.#backend.run(paneId, command);
		} catch (error) {
			this.#log("pane run failed", { key, paneId, error: describeError(error) });
			if (this.#entries.get(key) === entry) {
				await this.#removeSubtree(key);
				this.#promote();
			}
			return;
		}
		// finish() may have arrived while the backend was busy: schedule the close it could not.
		if (entry.done && this.#entries.get(key) === entry) this.#scheduleClose(key, entry);
	}

	/** Each parent gets its own column; only its direct children can be stacked together. */
	async #splitFor(key: string, entry: Entry): Promise<string> {
		const parent = entry.parentKey === undefined ? this.#config.mainPaneId : this.#entries.get(entry.parentKey)?.paneId;
		if (parent === undefined) throw new Error("parent viewer is no longer available");
		const siblings = this.#stackedEntries(entry.parentKey);
		let target: string | undefined;
		if (siblings.length > 0 || entry.parentKey !== undefined) {
			try {
				const panes = await this.#backend.layout(this.#config.mainPaneId);
				const parentPane = panes.find((pane) => pane.paneId === parent);
				if (entry.parentKey !== undefined && !parentPane) {
					throw new Error("parent viewer pane is no longer present");
				}
				let candidates = siblings;
				if (entry.parentKey !== undefined && parentPane) {
					if (this.#backend.supportsLayoutPosition === false) candidates = [];
					else candidates = siblings.filter((sibling) => {
						const pane = panes.find((item) => item.paneId === sibling.paneId);
						return pane !== undefined && pane.rect.y >= parentPane.rect.y
							&& pane.rect.y + pane.rect.height <= parentPane.rect.y + parentPane.rect.height;
					});
				}
				candidates = candidates.filter((candidate) => this.#canSplitDown(candidate, panes));
				target = tallestPaneId(panes, candidates);
			} catch (error) {
				if (entry.parentKey !== undefined) throw error;
				this.#log("pane layout failed", { key, error: describeError(error) });
			}
		}
		return target === undefined
			? this.#split(parent, "right", this.#config.ratio)
			: this.#split(target, "down", STACK_SPLIT_RATIO);
	}

	/** A downward split must not move a parent wholly above any of its existing children. */
	#canSplitDown(entry: Entry, panes: LayoutPane[]): boolean {
		const children = [...this.#entries.values()].filter((child) => child.parentKey === entry.key && child.paneId !== undefined);
		if (children.length === 0) return true;
		if (this.#backend.supportsLayoutPosition === false) return false;
		const target = panes.find((pane) => pane.paneId === entry.paneId);
		if (!target) return false;
		const top = target.rect.y;
		const bottom = top + Math.floor((target.rect.height - 1) * STACK_SPLIT_RATIO);
		for (const child of children) {
			const pane = panes.find((item) => item.paneId === child.paneId);
			if (pane && (pane.rect.y >= bottom || pane.rect.y + pane.rect.height <= top)) return false;
		}
		return true;
	}

	#split(target: string, direction: "right" | "down", ratio: number): Promise<string> {
		if (this.#backend.supportsRatio === false) return this.#backend.split(target, direction);
		return this.#backend.split(target, direction, ratio);
	}

	/** Only siblings, never a different parent's descendants, are valid stack targets. */
	#stackedEntries(parentKey: string | undefined): Entry[] {
		const stacked: Entry[] = [];
		for (const entry of this.#entries.values()) {
			if (entry.parentKey === parentKey && entry.paneId !== undefined) stacked.push(entry);
		}
		return stacked;
	}

	/**
	 * Schedules the delayed close of a finished entry; a second call while one is pending is a no-op.
	 */
	#scheduleClose(key: string, entry: Entry): void {
		if (this.#config.autoClose === false) return;
		if (entry.timer !== undefined) return;
		const configured = entry.status === "completed" ? this.#config.closeDelayMs : this.#config.failCloseDelayMs;
		const elapsed = entry.finishedAt === undefined ? 0 : Math.max(0, this.#now() - entry.finishedAt);
		const delay = Math.max(0, configured - elapsed);
		const generation = entry.closeGeneration;
		const timer = this.#schedule(() => {
			if (entry.timer !== timer) return;
			entry.timer = undefined;
			void this.#enqueueClose(key, entry, generation);
		}, delay);
		entry.timer = timer;
	}

	/** Opens eligible waiting subagents while slots are free, preserving arrival order. */
	#promote(): void {
		for (const [key, request] of this.#waiting) {
			if (this.#entries.size >= this.#config.maxPanes) break;
			if (request.parentKey !== undefined && !this.#entries.has(request.parentKey)) continue;
			this.#waiting.delete(key);
			void this.open(key, request.label, request.parentKey);
		}
		if (this.#needsReconcile()) this.#scheduleReconcile();
		else this.#cancelReconcile();
	}

	#needsReconcile(): boolean {
		return (this.#config.monitorPanes === true && this.#entries.size > 0)
			|| (this.#config.autoClose === false && this.#waiting.size > 0)
			|| [...this.#entries.values()].some((entry) => entry.parentKey !== undefined);
	}

	#scheduleReconcile(): void {
		if (!this.#needsReconcile() || this.#reconcileTimer !== undefined) return;
		const generation = this.#reconcileGeneration;
		const timer = this.#schedule(() => {
			if (this.#reconcileTimer !== timer) return;
			if (generation !== this.#reconcileGeneration) return;
			this.#reconcileTimer = undefined;
			void this.#enqueue(async () => {
				if (generation !== this.#reconcileGeneration || !this.#needsReconcile()) return;
				const candidates = [...this.#entries];
				try {
					const panes = await this.#backend.layout(this.#config.mainPaneId);
					if (generation !== this.#reconcileGeneration || !this.#needsReconcile()) return;
					const present = new Set(panes.map((pane) => pane.paneId));
					for (const [key, entry] of candidates) {
						if (entry.paneId !== undefined && !present.has(entry.paneId) && this.#entries.get(key) === entry) {
							await this.#removeSubtree(key, entry.paneId);
						}
					}
					this.#promote();
				} catch (error) {
					this.#log("pane layout failed", { error: describeError(error) });
				}
				if (generation === this.#reconcileGeneration) this.#scheduleReconcile();
			});
		}, RECONCILE_DELAY_MS);
		this.#reconcileTimer = timer;
	}

	#cancelReconcile(): void {
		this.#reconcileGeneration += 1;
		this.#reconcileTimer?.cancel();
		this.#reconcileTimer = undefined;
	}

	/** Sets the pane title when the backend supports per-pane titles. */
	async #rename(key: string, paneId: string, entry: Entry): Promise<void> {
		if (this.#backend.rename === undefined) return;
		const mark = entry.status === undefined ? "" : entry.status === "completed" ? "✓ " : "✗ ";
		try {
			await this.#backend.rename(paneId, `${mark}${entry.label}`);
		} catch (error) {
			this.#log("pane rename failed", { key, paneId, error: describeError(error) });
		}
	}

	/** Queues the actual close; the entry must still be the finished one when the job finally runs. */
	#enqueueClose(key: string, entry: Entry, generation: number | undefined): Promise<void> {
		return this.#enqueue(async () => {
			// Gone, replaced, or revived (done === false) since the timer was armed → leave it alone.
			if (this.#entries.get(key) !== entry || !entry.done || entry.closeGeneration !== generation) return;
			const paneId = entry.paneId;
			if (paneId === undefined) return;
			await this.#removeSubtree(key);
			this.#promote();
		});
	}
	/** Forget a parent and its descendants before closing, so late opens cannot attach to it. */
	async #removeSubtree(root: string, missingPane?: string): Promise<void> {
		const removed = new Set([root]);
		let changed = true;
		while (changed) {
			changed = false;
			for (const [key, entry] of this.#entries) {
				if (entry.parentKey !== undefined && removed.has(entry.parentKey) && !removed.has(key)) {
					removed.add(key);
					changed = true;
				}
			}
			for (const [key, request] of this.#waiting) {
				if (request.parentKey !== undefined && removed.has(request.parentKey) && !removed.has(key)) {
					removed.add(key);
					changed = true;
				}
			}
		}
		const closing: Array<[string, Entry]> = [];
		for (const key of removed) {
			this.#waiting.delete(key);
			const entry = this.#entries.get(key);
			if (!entry) continue;
			this.#entries.delete(key);
			this.#cancelTimer(entry);
			closing.push([key, entry]);
		}
		for (const [key, entry] of closing.reverse()) {
			if (entry.paneId === missingPane) entry.paneId = undefined;
			else if (entry.paneId !== undefined && await this.#closePane(entry.paneId, key)) entry.paneId = undefined;
		}
	}

	async #closePane(paneId: string, key: string): Promise<boolean> {
		try {
			await this.#backend.close(paneId);
			return true;
		} catch (error) {
			if (error instanceof HerdrError && error.code === "pane_not_found") return true;
			this.#log("pane close failed", { key, paneId, error: describeError(error) });
			return false;
		}
	}

	#cancelTimer(entry: Entry): void {
		if (entry.timer === undefined) return;
		entry.timer.cancel();
		entry.timer = undefined;
	}

	/** Diagnostics must never break the job chain, so a throwing logger is swallowed too. */
	#log(message: string, context?: Record<string, unknown>): void {
		try {
			this.#logger(message, context);
		} catch {
			// Nothing left to report to.
		}
	}
}

/** Pane id of the tallest tracked pane present in `panes`; ties go to the highest open order. */
function tallestPaneId(panes: LayoutPane[], candidates: Entry[]): string | undefined {
	const heights = new Map<string, number>();
	for (const pane of panes) heights.set(pane.paneId, pane.rect.height);
	let bestId: string | undefined;
	let bestHeight = Number.NEGATIVE_INFINITY;
	let bestOrder = Number.NEGATIVE_INFINITY;
	for (const entry of candidates) {
		const paneId = entry.paneId;
		if (paneId === undefined) continue;
		const height = heights.get(paneId);
		if (height === undefined) continue;
		if (height > bestHeight || (height === bestHeight && entry.order > bestOrder)) {
			bestId = paneId;
			bestHeight = height;
			bestOrder = entry.order;
		}
	}
	return bestId;
}

/**
 * `setTimeout`/`clearTimeout` with the callback body wrapped in try/catch: an uncaught throw in a
 * timer kills the whole omp session, so timer failures are reported instead.
 */
function defaultSchedule(log: Log): Schedule {
	return (fn, ms) => {
		const handle = setTimeout(() => {
			try {
				fn();
			} catch (error) {
				log("scheduled callback failed", { error: describeError(error) });
			}
		}, ms);
		return { cancel: () => clearTimeout(handle) };
	};
}

/** Renders an unknown thrown value for a log context, keeping `HerdrError.code` visible. */
function describeError(error: unknown): string {
	if (error instanceof Error) {
		const code: unknown = "code" in error ? error.code : undefined;
		return typeof code === "string"
			? `${error.name} ${code}: ${error.message}`
			: `${error.name}: ${error.message}`;
	}
	return String(error);
}
