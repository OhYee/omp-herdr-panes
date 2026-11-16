import { recordOf, sanitize, summarizeArgs } from "./render.ts";

export type CardKind = "input" | "thinking" | "tools" | "tool" | "execution" | "result" | "output" | "status";

export interface Card {
	id: string;
	kind: CardKind;
	title: string;
	body: string;
	expanded: boolean;
	error?: boolean;
	live?: boolean;
	toolCallId?: string;
	result?: Card;
	execution?: Card[];
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return pretty(content);
	return content.map((block) => {
		const item = recordOf(block);
		if (item === null) return pretty(block);
		if (item["type"] === "text" && typeof item["text"] === "string") return item["text"];
		if (item["type"] === "image") return "[image]";
		return pretty(item);
	}).filter(Boolean).join("\n");
}

function pretty(value: unknown): string {
	try { return JSON.stringify(value, null, 2) ?? ""; } catch { return ""; }
}

function cardForBlock(block: unknown, id: string, live: boolean, expanded?: boolean): Card | undefined {
	const item = recordOf(block);
	if (!item) return { id, kind: "status", title: "BLOCK unknown", body: pretty(block), expanded: expanded ?? false, live };
	if (item["type"] === "unknown_live_block" && typeof item["preview"] === "string") {
		const type = typeof item["originalType"] === "string" ? item["originalType"] : "unknown";
		return { id, kind: "status", title: `BLOCK ${type}`, body: item["preview"], expanded: expanded ?? false, live };
	}
	if (item["type"] === "thinking" && typeof item["thinking"] === "string") {
		return { id, kind: "thinking", title: "THINK", body: item["thinking"], expanded: expanded ?? false, live };
	}
	if (item["type"] === "text" && typeof item["text"] === "string") {
		return { id, kind: "output", title: "OUTPUT", body: item["text"], expanded: expanded ?? true, live };
	}
	if (item["type"] === "image") {
		return { id, kind: "output", title: "OUTPUT image", body: "[image]", expanded: expanded ?? true, live };
	}
	if (item["type"] === "toolCall" && typeof item["name"] === "string") {
		const name = item["name"];
		const intent = typeof item["intent"] === "string" ? item["intent"] : "";
		const args = item["arguments"];
		const summary = intent || summarizeArgs(args);
		const title = summary ? `TOOL ${name} · ${summary}` : `TOOL ${name}`;
		return { id, kind: "tool", title, body: pretty(args), expanded: expanded ?? false, live,
			toolCallId: typeof item["id"] === "string" && item["id"] ? item["id"] : undefined };
	}
	return { id, kind: "status", title: `BLOCK ${typeof item["type"] === "string" ? item["type"] : "unknown"}`, body: pretty(item), expanded: expanded ?? false, live };
}

function appendCard(cards: Card[], card: Card): void {
	const previous = cards[cards.length - 1];
	if (card.kind === "thinking" && previous?.kind === "thinking") {
		previous.body += `\n${card.body}`;
		previous.live ||= card.live;
	} else cards.push(card);
}

/** Incremental transcript model; file entries are durable, socket snapshots are transient. */
export class TranscriptModel {
	cards: Card[] = [];
	live: Card[] = [];
	selected = 0;
	follow = true;
	status = "waiting";
	agent = "";
	model = "";
	private sequence = 0;
	private thinkingExpanded = false;
	private toolsExpanded = false;
	private lastLiveExpansion = new Map<string, boolean>();
	private readonly toolGroups = new Map<string, Card>();
	private boundaryThinking?: { savedId: string; liveId: string; card: Card };
	private lastLiveGroups = new Map<string, boolean>();

	streamStatus: "connecting" | "live" | "unavailable" | undefined;
	get all(): Card[] {
		const cards = [...this.cards, ...this.live];
		const saved = this.cards[this.cards.length - 1];
		const live = this.live[0];
		if (saved?.kind === "thinking" && live?.kind === "thinking") {
			if (this.boundaryThinking?.savedId !== saved.id || this.boundaryThinking.liveId !== live.id) {
				this.boundaryThinking = { savedId: saved.id, liveId: live.id, card: { ...saved, id: `thinking:${saved.id}:${live.id}` } };
			}
			const merged = this.boundaryThinking.card;
			merged.body = `${saved.body}\n${live.body}`;
			merged.live = true;
			cards.splice(this.cards.length - 1, 2, merged);
		}
		const calls = new Map<string, Card | null>();
		const results = new Map<string, Card | null>();
		for (const card of cards) {
			if (card.kind === "tool") { card.result = undefined; card.execution = undefined; }
			const index = card.kind === "tool" ? calls : card.kind === "result" ? results : undefined;
			if (index && card.toolCallId) index.set(card.toolCallId, index.has(card.toolCallId) ? null : card);
		}
		const paired = new Set<Card>();
		for (const [id, call] of calls) {
			const result = results.get(id);
			if (!call || !result) continue;
			call.result = result;
			paired.add(result);
		}
		for (const card of cards) {
			if (card.kind !== "execution" || !card.toolCallId) continue;
			const call = calls.get(card.toolCallId);
			if (!call) continue;
			(call.execution ??= []).push(card);
			paired.add(card);
		}
		let length = 0;
		for (const card of cards) if (!paired.has(card)) cards[length++] = card;
		cards.length = length;
		const visible: Card[] = [];
		for (let index = 0; index < cards.length; index++) {
			const first = cards[index]!;
			if (first.kind !== "tool") { visible.push(first); continue; }
			let end = index;
			let count = 0;
			let streaming = false;
			while (end < cards.length && (cards[end]!.kind === "tool" || cards[end]!.kind === "result")) {
				if (cards[end]!.kind === "tool") count++;
				streaming ||= cards[end]!.live === true;
				end++;
			}
			if (count < 2) { visible.push(first); continue; }
			const id = `tools:${first.id}`;
			let group = this.toolGroups.get(id);
			if (!group) {
				group = { id, kind: "tools", title: "", body: "", expanded: this.toolsExpanded };
				this.toolGroups.set(id, group);
			}
			group.title = `TOOLS: ${count}`;
			group.live = streaming;
			visible.push(group);
			if (group.expanded) for (let child = index; child < end; child++) visible.push(cards[child]!);
			index = end - 1;
		}
		return visible;
	}

	append(entry: unknown): boolean {
		const record = recordOf(entry);
		if (!record) return this.appendFallback("ENTRY unknown", entry);
		if (record["type"] === "session_init") {
			this.agent = typeof record["agent"] === "string" ? record["agent"] : "";
			if (typeof record["resolvedModel"] === "string" && record["resolvedModel"]) this.model = record["resolvedModel"];
			this.status = "running";
			return true;
		}
		if (record["type"] === "model_change") {
			const role = record["role"];
			if ((role === undefined || role === "default" || role === "fallback") && typeof record["model"] === "string" && record["model"]) {
				this.model = record["model"];
				return true;
			}
			return this.appendFallback("ENTRY model_change", record);
		}
		if (record["type"] === "custom" && record["customType"] === "session_exit") {
			if (this.status === "waiting" || this.status === "running") this.status = "ended";
			this.live = [];
			return true;
		}
		if (record["type"] === "custom" && record["customType"] === "tool_execution_start") {
			const data = recordOf(record["data"]);
			const toolCallId = typeof data?.["toolCallId"] === "string" && data["toolCallId"] ? data["toolCallId"] : undefined;
			this.cards.push({ id: `entry-${this.sequence++}`, kind: "execution", title: "ENTRY custom tool_execution_start",
				body: pretty(record), expanded: this.toolsExpanded, toolCallId });
			if (this.follow) this.selected = Math.max(0, this.all.length - 1);
			return true;
		}
		if (record["type"] !== "message") {
			const type = typeof record["type"] === "string" ? record["type"] : "unknown";
			const detail = typeof record["customType"] === "string" ? ` ${record["customType"]}` : "";
			return this.appendFallback(`ENTRY ${type}${detail}`, record);
		}
		const message = recordOf(record["message"]);
		if (!message) return this.appendFallback("MESSAGE unknown", record);
		const role = message["role"];
		let modelChanged = false;
		if (!this.model && role === "assistant" && typeof message["model"] === "string" && message["model"]) {
			const provider = typeof message["provider"] === "string" ? message["provider"] : "";
			this.model = provider && !message["model"].startsWith(`${provider}/`) ? `${provider}/${message["model"]}` : message["model"];
			modelChanged = true;
		}
		const id = typeof record["id"] === "string" ? record["id"] : `entry-${this.sequence++}`;
		const added: Card[] = [];
		if (role === "user" && message["content"] !== undefined) {
			added.push({ id, kind: "input", title: "INPUT", body: textOf(message["content"]), expanded: true });
		} else if (role === "assistant" && Array.isArray(message["content"])) {
			const liveExpansion = new Map(this.live.map(card => [`${card.id}:${card.kind}`, card.expanded]));
			for (const [index, block] of message["content"].entries()) {
				const card = cardForBlock(block, `${id}:${index}`, false);
				if (card) {
					const key = `live:${index}:${card.kind}`;
					card.expanded = liveExpansion.get(key) ?? this.lastLiveExpansion.get(key) ??
						(card.kind === "thinking" ? this.thinkingExpanded : card.kind === "tool" ? this.toolsExpanded : card.expanded);
					if (card.kind === "thinking" && this.boundaryThinking?.liveId === `live:${index}` &&
						this.cards[this.cards.length - 1]?.id === this.boundaryThinking.savedId) {
						this.cards[this.cards.length - 1]!.expanded = this.boundaryThinking.card.expanded;
					}
					if (card.kind === "tool") {
						const expanded = this.toolGroups.get(`tools:live:${index}`)?.expanded ?? this.lastLiveGroups.get(`live:${index}`);
						if (expanded !== undefined) {
							const groupId = `tools:${card.id}`;
							this.toolGroups.set(groupId, { id: groupId, kind: "tools", title: "", body: "", expanded });
						}
					}
					added.push(card);
				}
			}
			this.live = [];
			this.lastLiveExpansion.clear();
			this.boundaryThinking = undefined;
			this.lastLiveGroups.clear();
			if (message["stopReason"] === "error" || message["stopReason"] === "aborted") {
				const error = typeof message["errorMessage"] === "string" ? message["errorMessage"] : String(message["stopReason"]);
				added.push({ id: `${id}:error`, kind: "status", title: "ERROR", body: error, expanded: false, error: true });
			}
		} else if (role === "toolResult" && message["content"] !== undefined) {
			const name = typeof message["toolName"] === "string" ? message["toolName"] : "tool";
			const error = message["isError"] === true;
			added.push({ id, kind: "result", title: `${error ? "ERROR" : "RESULT"} ${name}`, body: textOf(message["content"]), expanded: this.toolsExpanded, error,
				toolCallId: typeof message["toolCallId"] === "string" && message["toolCallId"] ? message["toolCallId"] : undefined });
		} else return this.appendFallback(`MESSAGE ${typeof role === "string" ? role : "unknown"}`, record);
		if (role === "user" && this.status === "ended") this.status = "running";
		for (const card of added) appendCard(this.cards, card);
		if (this.follow && added.length > 0) this.selected = Math.max(0, this.all.length - 1);
		return added.length > 0 || modelChanged;
	}

	private appendFallback(title: string, value: unknown): boolean {
		this.cards.push({ id: `entry-${this.sequence++}`, kind: "status", title, body: pretty(value), expanded: false });
		if (this.follow) this.selected = Math.max(0, this.all.length - 1);
		return true;
	}

	appendLiveEvent(type: string, text: string): void {
		let toolCallId: string | undefined;
		if (type === "tool_execution_start") {
			try {
				const event = recordOf(JSON.parse(text));
				if (typeof event?.["toolCallId"] === "string" && event["toolCallId"]) toolCallId = event["toolCallId"];
			} catch { /* Truncated or malformed events remain separately visible. */ }
		}
		this.cards.push({ id: `event-${this.sequence++}`, kind: type === "tool_execution_start" ? "execution" : "status",
			title: `EVENT ${type}`, body: text, expanded: type === "tool_execution_start" && this.toolsExpanded, live: true, toolCallId });
		if (this.follow) this.selected = Math.max(0, this.all.length - 1);
	}

	setLive(content: unknown[]): void {
		const old = new Map(this.live.map(card => [`${card.id}:${card.kind}`, card.expanded]));
		const live: Card[] = [];
		for (const [index, block] of content.entries()) {
			const card = cardForBlock(block, `live:${index}`, true);
			if (!card) continue;
			card.expanded = old.get(`${card.id}:${card.kind}`) ??
				(card.kind === "thinking" ? this.thinkingExpanded : card.kind === "tool" ? this.toolsExpanded : card.expanded);
			appendCard(live, card);
		}
		this.live = live;
		this.status = "running";
		if (this.follow && this.live.length) this.selected = Math.max(0, this.all.length - 1);
	}

	clearLive(): void {
		if (this.live.length) {
			this.lastLiveExpansion = new Map(this.live.map(card => [`${card.id}:${card.kind}`, card.expanded]));
			this.lastLiveGroups.clear();
			for (const card of this.live) {
				const id = `tools:${card.id}`;
				const group = this.toolGroups.get(id);
				if (group) this.lastLiveGroups.set(card.id, group.expanded);
				this.toolGroups.delete(id);
			}
		}
		this.live = [];
		this.selected = Math.min(this.selected, Math.max(0, this.all.length - 1));
	}

	move(delta: number): void {
		const count = this.all.length;
		if (!count) return;
		this.selected = Math.max(0, Math.min(count - 1, this.selected + delta));
		this.follow = this.selected === count - 1;
	}

	toggle(): void {
		const card = this.all[this.selected];
		if (card) card.expanded = !card.expanded;
	}

	toggleThinking(): void {
		const visible = this.all.filter(card => card.kind === "thinking");
		const expand = visible.length ? visible.some(card => !card.expanded) : !this.thinkingExpanded;
		this.thinkingExpanded = expand;
		for (const card of [...this.cards, ...this.live, ...visible]) {
			if (card.kind === "thinking") card.expanded = expand;
		}
		for (const key of this.lastLiveExpansion.keys()) {
			if (key.endsWith(":thinking")) this.lastLiveExpansion.set(key, expand);
		}
		if (this.boundaryThinking) this.boundaryThinking.card.expanded = expand;
	}

	toggleTools(): void {
		const visible = this.all;
		const selected = visible[this.selected];
		let parentId: string | undefined;
		if (selected?.kind === "tool" || selected?.kind === "result") {
			for (let index = this.selected - 1; index >= 0; index--) {
				const card = visible[index]!;
				if (card.kind === "tools") { parentId = card.id; break; }
				if (card.kind !== "tool" && card.kind !== "result") break;
			}
		}
		const cards = [...this.cards, ...this.live];
		const paired = new Set(cards.flatMap(card => [...(card.result ? [card.result] : []), ...(card.execution ?? [])]));
		const tools = cards.filter(card => (card.kind === "tool" || card.kind === "result" || card.kind === "execution") && !paired.has(card));
		const groups = visible.filter(card => card.kind === "tools");
		const expand = tools.length || groups.length
			? tools.some(card => !card.expanded) || groups.some(card => !card.expanded)
			: !this.toolsExpanded;
		this.toolsExpanded = expand;
		for (const card of [...tools, ...groups]) card.expanded = expand;
		for (const key of this.lastLiveExpansion.keys()) {
			if (key.endsWith(":tool")) this.lastLiveExpansion.set(key, expand);
		}
		for (const key of this.lastLiveGroups.keys()) this.lastLiveGroups.set(key, expand);
		const after = this.all;
		let index = after.findIndex(card => card.id === selected?.id);
		if (index < 0 && parentId) index = after.findIndex(card => card.id === parentId);
		this.selected = index >= 0 ? index : Math.min(this.selected, Math.max(0, after.length - 1));
	}

	toggleAll(): void {
		const visible = this.all;
		const selected = visible[this.selected];
		let parentId: string | undefined;
		if (selected?.kind === "tool" || selected?.kind === "result") {
			for (let index = this.selected - 1; index >= 0; index--) {
				const card = visible[index]!;
				if (card.kind === "tools") { parentId = card.id; break; }
				if (card.kind !== "tool" && card.kind !== "result") break;
			}
		}
		const cards = [...this.cards, ...this.live];
		const paired = new Set<Card>();
		for (const card of cards) {
			if (card.result) paired.add(card.result);
			for (const execution of card.execution ?? []) paired.add(execution);
		}
		const actionable = cards.filter(card => !paired.has(card));
		const expand = visible.some(card => !card.expanded) || actionable.some(card => !card.expanded);
		this.thinkingExpanded = expand;
		this.toolsExpanded = expand;
		for (const card of visible) card.expanded = expand;
		for (const card of actionable) card.expanded = expand;
		const after = this.all;
		let index = after.findIndex(card => card.id === selected?.id);
		if (index < 0 && parentId) index = after.findIndex(card => card.id === parentId);
		this.selected = index >= 0 ? index : Math.min(this.selected, Math.max(0, after.length - 1));
	}
}

/** Strip control sequences and flatten a card title into a single safe terminal line. */
export function cardSummary(value: string): string {
	return sanitize(value).replace(/\s+/gu, " ").trim();
}
