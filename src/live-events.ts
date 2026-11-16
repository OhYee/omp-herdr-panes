import { recordOf } from "./render.ts";
import type { Schedule } from "./pane-manager.ts";

interface LiveSink { publish(id: string, frame: unknown): void }
interface Pending {
	content: unknown[];
	timer?: { cancel(): void };
}

const PREVIEW_LIMIT = 256 * 1024;
const COALESCE_MS = 80;

/** Coalesce live assistant snapshots while persisted JSONL remains the full transcript. */
export class LiveEvents {
	private readonly pending = new Map<string, Pending>();

	constructor(private readonly sink: LiveSink, private readonly schedule: Schedule = (fn, ms) => {
		const timer = setTimeout(fn, ms);
		timer.unref();
		return { cancel: () => clearTimeout(timer) };
	}) {}

	handle(payload: unknown): void {
		const frame = recordOf(payload);
		const id = frame?.["id"];
		const event = recordOf(frame?.["event"]);
		if (typeof id !== "string" || !event) return;
		const message = recordOf(event["message"]);
		if (event["type"] === "message_start" && message?.["role"] === "assistant") {
			this.clear(id);
			return;
		}
		if (event["type"] === "message_end" && message?.["role"] === "assistant") {
			this.clear(id);
			return;
		}
		if (event["type"] !== "message_update" || message?.["role"] !== "assistant") return;
		const delta = recordOf(event["assistantMessageEvent"]);
		const partial = recordOf(delta?.["partial"]);
		const content = Array.isArray(partial?.["content"]) ? partial["content"] : message["content"];
		if (!Array.isArray(content)) return;
		const pending = this.pending.get(id) ?? { content: [] };
		pending.content = content;
		if (!pending.timer) {
			pending.timer = this.schedule(() => {
				if (this.pending.get(id) !== pending) return;
				pending.timer = undefined;
				this.sink.publish(id, { type: "live", content: snapshot(pending.content) });
			}, COALESCE_MS);
		}
		this.pending.set(id, pending);
	}

	clear(id: string): void {
		const pending = this.pending.get(id);
		pending?.timer?.cancel();
		this.pending.delete(id);
		this.sink.publish(id, { type: "clear" });
	}

	close(): void {
		for (const pending of this.pending.values()) pending.timer?.cancel();
		this.pending.clear();
	}
}

function snapshot(content: unknown[]): unknown[] {
	let budget = PREVIEW_LIMIT;
	const blocks: unknown[] = [];
	for (const raw of content) {
		const block = recordOf(raw);
		if (!block) continue;
		const type = block["type"];
		if (type === "text" || type === "thinking") {
			const field = type === "text" ? "text" : "thinking";
			const value = block[field];
			if (typeof value !== "string") continue;
			const shown = value.length > budget ? `${value.slice(0, Math.max(0, budget))}\n[Live preview truncated; full content appears when saved.]` : value;
			blocks.push({ type, [field]: shown });
			budget -= Math.min(value.length, budget);
		} else if (type === "toolCall" && typeof block["name"] === "string") {
			const args = block["arguments"];
			let serialized = "";
			try { serialized = JSON.stringify(args) ?? ""; } catch { serialized = ""; }
			const shownArgs = serialized.length > budget ? "[Live arguments truncated; full content appears when saved.]" : args;
			blocks.push({ type, id: block["id"], name: block["name"], intent: block["intent"], arguments: shownArgs });
			budget -= Math.min(serialized.length, budget);
		}
		if (budget <= 0) {
			blocks.push({ type: "text", text: "[Additional live content omitted; full content appears when saved.]" });
			break;
		}
	}
	return blocks;
}
