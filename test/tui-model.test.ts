import { expect, test } from "bun:test";
import { cardSummary, TranscriptModel } from "../src/tui-model.ts";

const message = (role: string, content: unknown, extra: Record<string, unknown> = {}) =>
	({ type: "message", message: { role, content, ...extra } });

test("shows the resolved model and follows default-model changes, ignoring other roles", () => {
	const model = new TranscriptModel();
	model.append({ type: "model_change", model: "old/default" });
	model.append({ type: "session_init", agent: "scout", resolvedModel: "provider/model:high" });
	expect(model.model).toBe("provider/model:high");
	model.append({ type: "model_change", role: "smol", model: "other/auxiliary" });
	expect(model.model).toBe("provider/model:high");
	model.append({ type: "model_change", role: "default", model: "provider/new-model" });
	expect(model.model).toBe("provider/new-model");
	model.append({ type: "model_change", role: "fallback", model: "provider/promoted-model" });
	expect(model.model).toBe("provider/promoted-model");
	model.append({ type: "model_change", role: "default", model: "provider/new-model" });
	model.append({ type: "model_change", model: "" });
	model.append({ type: "session_init", agent: "scout" });
	expect(model.model).toBe("provider/new-model");
});

test("uses assistant message metadata only when the session has no model metadata", () => {
	const model = new TranscriptModel();
	expect(model.append(message("assistant", [], { provider: "provider", model: "actual-model" }))).toBe(true);
	expect(model.model).toBe("provider/actual-model");
	model.append(message("assistant", [], { provider: "other", model: "different-model" }));
	expect(model.model).toBe("provider/actual-model");
});

test("shows input, thinking, tool arguments, tool result and output with full content available", () => {
	const model = new TranscriptModel();
	model.append(message("user", [{ type: "text", text: "检查代码\n  约束：不改 API" }]));
	model.append(message("assistant", [
		{ type: "thinking", thinking: "先读取文件\n然后定位错误" },
		{ type: "toolCall", name: "read", intent: "读取配置", arguments: { path: "src/config.ts" } },
	]));
	model.append(message("toolResult", [{ type: "text", text: "first\n  second\nthird" }], { toolName: "read" }));
	model.append(message("assistant", [{ type: "text", text: "```ts\nif (x) {\n  fix();\n}\n```" }]));
	expect(model.all.map(card => card.kind)).toEqual(["input", "thinking", "tool", "result", "output"]);
	expect(model.all[0]?.body).toContain("  约束");
	expect(model.all[2]?.body).toContain("src/config.ts");
	expect(model.all[3]?.body).toBe("first\n  second\nthird");
	expect(model.all[4]?.body).toContain("\n  fix();\n");
	expect(model.all[1]?.expanded).toBe(false);
	model.selected = 1;
	model.toggle();
	expect(model.all[1]?.expanded).toBe(true);
	model.toggle();
	expect(model.all[1]?.expanded).toBe(false);
});

test("live text updates replace the transient card and persisted output does not duplicate it", () => {
	const model = new TranscriptModel();
	model.setLive([{ type: "text", text: "你" }]);
	model.setLive([{ type: "text", text: "你好" }]);
	expect(model.all.map(card => card.body)).toEqual(["你好"]);
	model.append(message("assistant", [{ type: "text", text: "你好" }]));
	expect(model.all.map(card => card.body)).toEqual(["你好"]);
	expect(model.all[0]?.live).toBe(false);
});

test("thinking starts folded and keeps a manual expansion when a live message is saved", () => {
	const model = new TranscriptModel();
	const content = [{ type: "thinking", thinking: "思考过程" }];
	model.setLive(content);
	expect(model.all[0]?.expanded).toBe(false);
	model.toggle();
	model.clearLive();
	model.append(message("assistant", content));
	expect(model.all[0]?.expanded).toBe(true);
});

test("a different block type does not inherit an unrelated live card's expansion", () => {
	const model = new TranscriptModel();
	model.setLive([{ type: "text", text: "partial output" }]);
	model.clearLive();
	model.append(message("assistant", [{ type: "toolCall", name: "read", arguments: { path: "x" } }]));
	expect(model.all[0]?.kind).toBe("tool");
	expect(model.all[0]?.expanded).toBe(false);
});

test("assistant and tool errors start folded but retain their full details", () => {
	const model = new TranscriptModel();
	model.append(message("assistant", [], { stopReason: "error", errorMessage: "provider failed\nfull details" }));
	model.append(message("toolResult", [{ type: "text", text: "tool failed\nfull details" }], { toolName: "bash", isError: true }));
	expect(model.all.map(card => [card.title, card.expanded, card.body])).toEqual([
		["ERROR", false, "provider failed\nfull details"],
		["ERROR bash", false, "tool failed\nfull details"],
	]);
});

test("groups consecutive tool calls and their results without hiding their details", () => {
	const model = new TranscriptModel();
	const call = (name: string) => ({ type: "toolCall", name, arguments: { path: `${name}.ts` } });
	model.append(message("assistant", [call("read"), call("grep")]));
	model.append(message("toolResult", [{ type: "text", text: "read result" }], { toolName: "read" }));
	model.append(message("toolResult", [{ type: "text", text: "grep error" }], { toolName: "grep", isError: true }));
	model.append(message("assistant", [{ type: "text", text: "done" }]));
	expect(model.all.map(card => card.title)).toEqual(["TOOLS: 2", "OUTPUT"]);
	model.selected = 0;
	model.toggle();
	expect(model.all.map(card => card.title)).toEqual([
		"TOOLS: 2", "TOOL read · read.ts", "TOOL grep · grep.ts", "RESULT read", "ERROR grep", "OUTPUT",
	]);
	model.move(1);
	model.toggle();
	expect(model.all[1]?.body).toContain("read.ts");
	expect(model.all[1]?.expanded).toBe(true);
	model.selected = 0;
	model.toggle();
	expect(model.all.map(card => card.title)).toEqual(["TOOLS: 2", "OUTPUT"]);
});

test("groups sequential calls separated by results but leaves single calls ungrouped", () => {
	const model = new TranscriptModel();
	const call = (name: string) => ({ type: "toolCall", name, arguments: {} });
	model.append(message("assistant", [call("read")]));
	model.append(message("toolResult", [{ type: "text", text: "read" }], { toolName: "read" }));
	expect(model.all.map(card => card.kind)).toEqual(["tool", "result"]);
	model.append(message("assistant", [call("grep")]));
	model.append(message("toolResult", [{ type: "text", text: "grep" }], { toolName: "grep" }));
	expect(model.all.map(card => card.title)).toEqual(["TOOLS: 2"]);
});

test("keeps a live tool group's folding state when its message is saved", () => {
	const model = new TranscriptModel();
	const content = [
		{ type: "toolCall", name: "read", arguments: {} },
		{ type: "toolCall", name: "grep", arguments: {} },
	];
	model.setLive(content);
	expect(model.all[0]?.title).toBe("TOOLS: 2");
	model.toggle();
	model.clearLive();
	model.append(message("assistant", content));
	expect(model.all[0]?.expanded).toBe(true);
	expect(model.all.map(card => card.kind)).toEqual(["tools", "tool", "tool"]);
});

test("collapsing all items keeps selection on the parent tools group", () => {
	const model = new TranscriptModel();
	model.append(message("assistant", [
		{ type: "toolCall", name: "read", arguments: {} },
		{ type: "toolCall", name: "grep", arguments: {} },
	]));
	model.toggleAll();
	model.selected = 1;
	model.toggleAll();
	expect(model.all.map(card => card.title)).toEqual(["TOOLS: 2"]);
	expect(model.all[model.selected]?.title).toBe("TOOLS: 2");
});

test("pairs parallel calls with their own results even when results arrive out of order", () => {
	const model = new TranscriptModel();
	model.append(message("assistant", [
		{ type: "toolCall", id: "a", name: "read", arguments: { path: "a.ts" } },
		{ type: "toolCall", id: "b", name: "read", arguments: { path: "b.ts" } },
	]));
	model.append(message("toolResult", "result B", { toolCallId: "b", toolName: "read", isError: true }));
	model.append(message("toolResult", "result A", { toolCallId: "a", toolName: "read" }));
	expect(model.all.map(card => card.title)).toEqual(["TOOLS: 2"]);
	model.toggle();
	expect(model.all.map(card => card.kind)).toEqual(["tools", "tool", "tool"]);
	expect(model.all[1]?.result?.body).toBe("result A");
	expect(model.all[2]?.result?.body).toBe("result B");
	expect(model.all[2]?.result?.error).toBe(true);
});

test("does not guess pairs for missing or ambiguous tool call identifiers", () => {
	const model = new TranscriptModel();
	model.append(message("assistant", [
		{ type: "toolCall", id: "duplicate", name: "read", arguments: {} },
		{ type: "toolCall", id: "duplicate", name: "read", arguments: {} },
	]));
	model.append(message("toolResult", "ambiguous", { toolCallId: "duplicate", toolName: "read" }));
	model.append(message("toolResult", "missing id", { toolName: "read" }));
	model.toggle();
	expect(model.all.map(card => card.kind)).toEqual(["tools", "tool", "tool", "result", "result"]);
	expect(model.all[1]?.result).toBeUndefined();
	expect(model.all[2]?.result).toBeUndefined();
});

test("matches a live call with an earlier saved result and keeps its expansion when persisted", () => {
	const model = new TranscriptModel();
	const content = [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "x" } }];
	model.append(message("toolResult", "finished", { toolCallId: "call-1", toolName: "read" }));
	model.setLive(content);
	expect(model.all.map(card => card.kind)).toEqual(["tool"]);
	expect(model.all[0]?.result?.body).toBe("finished");
	model.toggle();
	model.clearLive();
	model.append(message("assistant", content));
	expect(model.all[0]?.expanded).toBe(true);
	expect(model.all[0]?.result?.body).toBe("finished");
});

test("toggle-all still collapses a paired call after expanding it", () => {
	const model = new TranscriptModel();
	model.append(message("assistant", [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]));
	model.append(message("toolResult", "result", { toolCallId: "call-1", toolName: "read" }));
	model.toggleAll();
	expect(model.all[0]?.expanded).toBe(true);
	model.toggleAll();
	expect(model.all[0]?.expanded).toBe(false);
});

test("merges consecutive thinking content while preserving other message boundaries", () => {
	const model = new TranscriptModel();
	model.append(message("assistant", [{ type: "thinking", thinking: "第一段" }]));
	model.append(message("assistant", [
		{ type: "thinking", thinking: "第二段" },
		{ type: "text", text: "回答" },
		{ type: "thinking", thinking: "第三段" },
	]));
	expect(model.all.map(card => [card.kind, card.body])).toEqual([
		["thinking", "第一段\n第二段"], ["output", "回答"], ["thinking", "第三段"],
	]);
});

test("merges consecutive live thinking snapshots without repeating earlier text", () => {
	const model = new TranscriptModel();
	const content = [{ type: "thinking", thinking: "第一段" }, { type: "thinking", thinking: "第二段" }];
	model.setLive(content);
	model.setLive([{ ...content[0] }, { type: "thinking", thinking: "第二段更新" }]);
	expect(model.all.map(card => card.body)).toEqual(["第一段\n第二段更新"]);
	model.toggle();
	model.clearLive();
	model.append(message("assistant", content));
	expect(model.all[0]?.expanded).toBe(true);
});

test("merges thinking across a saved message and a following live snapshot", () => {
	const model = new TranscriptModel();
	model.append(message("assistant", [{ type: "thinking", thinking: "已保存" }]));
	model.setLive([{ type: "thinking", thinking: "实时新增" }]);
	expect(model.all.map(card => card.body)).toEqual(["已保存\n实时新增"]);
	model.selected = 0;
	model.toggle();
	model.clearLive();
	model.append(message("assistant", [{ type: "thinking", thinking: "实时新增" }]));
	expect(model.all[0]?.body).toBe("已保存\n实时新增");
	expect(model.all[0]?.expanded).toBe(true);
});

test("toggleThinking opens and closes all thinking without changing other cards", () => {
	const model = new TranscriptModel();
	model.append(message("assistant", [
		{ type: "thinking", thinking: "first" },
		{ type: "text", text: "answer" },
		{ type: "thinking", thinking: "second" },
	]));
	model.toggleThinking();
	expect(model.all.map(card => [card.kind, card.expanded])).toEqual([
		["thinking", true], ["output", true], ["thinking", true],
	]);
	model.toggleThinking();
	expect(model.all.map(card => [card.kind, card.expanded])).toEqual([
		["thinking", false], ["output", true], ["thinking", false],
	]);
});

test("toggleThinking applies to new and just-finished live thinking", () => {
	const model = new TranscriptModel();
	model.setLive([{ type: "thinking", thinking: "first" }]);
	model.clearLive();
	model.toggleThinking();
	model.append(message("assistant", [{ type: "thinking", thinking: "first" }]));
	expect(model.all[0]?.expanded).toBe(true);
	model.append(message("assistant", [{ type: "text", text: "answer" }]));
	model.setLive([{ type: "thinking", thinking: "next" }]);
	expect(model.all[2]?.expanded).toBe(true);
	model.toggleThinking();
	expect(model.all.filter(card => card.kind === "thinking").map(card => card.expanded)).toEqual([false, false]);
});

test("labels remove terminal control sequences while preserving Chinese text", () => {
	expect(cardSummary("\x1b]0;malicious\x07中文\x1b[31m标题\x1b[0m\nnext")).toBe("中文标题 next");
});
