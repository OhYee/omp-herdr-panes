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
		if (typeof id !== "string") return;
		if (!event) {
			this.sink.publish(id, { type: "event", name: "unknown", text: preview(frame?.["event"]) });
			return;
		}
		const message = recordOf(event["message"]);
		if (event["type"] === "message_start" && message?.["role"] === "assistant") {
			this.clear(id);
			return;
		}
		if (event["type"] === "message_end" && message?.["role"] === "assistant") {
			this.clear(id);
			return;
		}
		if (event["type"] !== "message_update" || message?.["role"] !== "assistant") {
			if ((event["type"] === "message_start" || event["type"] === "message_end") &&
				(message?.["role"] === "user" || message?.["role"] === "toolResult" ||
					(message?.["role"] === "custom" && message["customType"] === "irc:incoming"))) return;
			const type = event["type"];
			const execution = type === "tool_execution_start" || type === "tool_execution_update" ||
				type === "tool_stream_update" || type === "tool_execution_end" ||
				type === "tool_approval_requested" || type === "tool_approval_resolved";
			const toolCallId = execution && typeof event["toolCallId"] === "string" && event["toolCallId"] ? event["toolCallId"] : undefined;
			let content: unknown = type === "tool_execution_update" && "partialResult" in event ? event["partialResult"]
				: type === "tool_stream_update" && "update" in event ? event["update"] : event;
			if (type === "tool_execution_end") {
				const result = preview(event["result"]);
				content = { type, toolCallId, toolName: event["toolName"], isError: event["isError"],
					result: result.length > 8000 ? `${result.slice(0, 8000)}\n[Live event truncated.]` : event["result"] };
			}
			if (type === "plan_review_requested" && typeof event["planContent"] === "string" && event["planContent"].length > 8000) {
				content = { ...event, planContent: `${event["planContent"].slice(0, 8000)}\n[Live event truncated.]` };
			}
			if (type === "irc_message" && message) {
				const details = recordOf(message["details"]);
				const value = message["content"];
				const full = typeof value === "string" ? value : JSON.stringify(value);
				content = { type, message: { customType: message["customType"], display: message["display"],
					content: full && full.length > 8000 ? `${full.slice(0, 8000)}\n[Live event truncated.]` : value,
					details: { id: details?.["id"] } } };
			}
			this.sink.publish(id, { type: "event", name: typeof type === "string" ? type : "unknown", text: preview(content), ...(toolCallId ? { toolCallId } : {}) });
			return;
		}
		const delta = recordOf(event["assistantMessageEvent"]);
		const partial = recordOf(delta?.["partial"]);
		const content = Array.isArray(partial?.["content"]) ? partial["content"] : message["content"];
		if (!Array.isArray(content)) {
			this.sink.publish(id, { type: "event", name: "message_update", text: preview(event) });
			return;
		}
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

function preview(value: unknown): string {
	let text: string;
	try { text = JSON.stringify(value, null, 2) ?? String(value); } catch { text = "[Unserializable live event]"; }
	const limit = 64 * 1024;
	return text.length > limit ? `${text.slice(0, limit)}\n[Live event truncated.]` : text;
}

function snapshot(content: unknown[]): unknown[] {
	let budget = PREVIEW_LIMIT;
	const blocks: unknown[] = [];
	for (const raw of content) {
		const block = recordOf(raw);
		const type = block?.["type"];
		if ((type === "text" || type === "thinking") &&
			typeof block?.[type === "text" ? "text" : "thinking"] === "string") {
			const field = type === "text" ? "text" : "thinking";
			const value = block![field] as string;
			const shown = value.length > budget ? `${value.slice(0, Math.max(0, budget))}\n[Live preview truncated; full content appears when saved.]` : value;
			blocks.push({ type, [field]: shown });
			budget -= Math.min(value.length, budget);
		} else if (type === "toolCall" && typeof block?.["name"] === "string") {
			const args = block["arguments"];
			let serialized = "";
			try { serialized = JSON.stringify(args) ?? ""; } catch { serialized = ""; }
			const shownArgs = serialized.length > budget ? "[Live arguments truncated; full content appears when saved.]" : args;
			blocks.push({ type, id: block["id"], name: block["name"], intent: block["intent"], arguments: shownArgs });
			budget -= Math.min(serialized.length, budget);
		} else {
			const serialized = preview(raw);
			const shown = serialized.length > budget ? `${serialized.slice(0, Math.max(0, budget))}\n[Live preview truncated; full content appears when saved.]` : serialized;
			blocks.push({ type: "unknown_live_block", originalType: type, preview: shown });
			budget -= Math.min(serialized.length, budget);
		}
		if (budget <= 0) {
			blocks.push({ type: "text", text: "[Additional live content omitted; full content appears when saved.]" });
			break;
		}
	}
	return blocks;
}
