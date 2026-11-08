/**
 * 针对 openai-chat 的图文序列化测试。
 *
 * 本文件验证的是**实际发出的请求体**，不依赖真实 API Key、网络或模型回答：
 * mock 掉 globalThis.fetch，从 streamOpenAIChat 的真实调用里截获 messages。
 * 断言只关注顺序 / 配对 / 分组 / 内容完整性，不绑定具体英文措辞。
 *
 * 跑：./node_modules/.bin/tsx test/tool-result-images.test.ts
 */
import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import { streamOpenAIChat } from "../../src/llm/openai-chat.ts";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "../../src/types.ts";

const MODEL: Model = {
	id: "mock-model",
	name: "mock-model",
	provider: "openai",
	baseUrl: "https://mock.invalid/v1",
	api: "openai-completions",
	contextWindow: 128000,
};

// 最小可用的 SSE 响应：一条文本 delta + finish_reason stop，足以让 readSSE 正常收尾。
const SSE_BODY = [
	'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
	"",
	'data: {"choices":[{"finish_reason":"stop"}]}',
	"",
	"data: [DONE]",
	"",
].join("\n");

type WirePart = Record<string, unknown>;
type WireMessage = {
	role: string;
	content: unknown;
	tool_call_id?: string;
	tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
};

let captured: Array<{ url: string; body: Record<string, unknown> }> = [];

function installMockFetch(): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: unknown, init: { body?: string }) => {
		captured.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
		return new Response(SSE_BODY, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}) as unknown as typeof fetch;
	return () => {
		globalThis.fetch = original;
	};
}

/** 跑一次真实转换，返回请求体里的 messages。 */
async function convert(context: Context): Promise<WireMessage[]> {
	captured = [];
	const stream = await streamOpenAIChat(MODEL, context, { apiKey: "test-key" });
	for await (const _event of stream) {
		// 全部消费掉，确保 promise 链走完
	}
	const result = await stream.result();
	assert.equal(result.stopReason, "stop", "mock 响应应正常收尾");
	assert.equal(captured.length, 1, `应恰好发出 1 个请求，实际 ${captured.length}`);
	return captured[0].body.messages as WireMessage[];
}

// ---------- 构造工具 ----------

const txt = (text: string): TextContent => ({ type: "text", text });
/** data 是可反解的 base64，便于断言「哪张图」而不必比对长串。 */
const img = (tag: string): ImageContent => ({
	type: "image",
	mimeType: "image/png",
	data: Buffer.from(`IMG:${tag}`).toString("base64"),
});
const tagOf = (part: { image_url: { url: string } }): string =>
	Buffer.from(part.image_url.url.split(",")[1], "base64")
		.toString()
		.replace(/^IMG:/, "");

const user = (content: UserMessage["content"]): UserMessage => ({
	role: "user",
	content,
	timestamp: 1,
});

const assistantWithCalls = (...ids: string[]): AssistantMessage => ({
	role: "assistant",
	content: ids.map((id): ToolCall => ({ type: "toolCall", id, name: `tool_${id}`, arguments: {} })),
	model: MODEL.id,
	stopReason: "toolUse",
	timestamp: 2,
});

const toolResult = (
	toolCallId: string,
	content: ToolResultMessage["content"],
	// 注意：默认 toolName 刻意不含 id，避免「断言 toolName 时顺手把 id 也匹配上」的空断言
	toolName = "sometool",
): ToolResultMessage => ({
	role: "toolResult",
	toolCallId,
	toolName,
	content,
	isError: false,
	timestamp: 3,
});

// ---------- 读请求体的小工具 ----------

const parts = (msg: WireMessage): WirePart[] =>
	Array.isArray(msg.content) ? (msg.content as WirePart[]) : [{ type: "text", text: String(msg.content) }];

const textParts = (msg: WireMessage): string[] =>
	parts(msg)
		.filter((p) => p.type === "text")
		.map((p) => String(p.text));

const textOf = (msg: WireMessage): string => textParts(msg).join("|");

const imagesOf = (msg: WireMessage): string[] =>
	parts(msg)
		.filter((p) => p.type === "image_url")
		.map((p) => tagOf(p as unknown as { image_url: { url: string } }));

const rolesOf = (msgs: WireMessage[]): string[] => msgs.map((m) => m.role);

const LABEL_RE = /^\[tool result:/;
const CLOSE_RE = /^\[\/tool result/;
/** 附件开头「这些内容是工具返回」的说明文字不能长得像组标签。 */
const isHeader = (p: WirePart): boolean =>
	p.type === "text" && !LABEL_RE.test(String(p.text)) && !CLOSE_RE.test(String(p.text));

type Group = { label: string; body: WirePart[]; closing: string };

/**
 * 把附件消息解析成「首部说明 + 若干组」。每组必须是
 * 来源标签 → 正文（保序）→ 结束边界，任一项缺失即断言失败。
 */
function parseAttachment(msg: WireMessage): { header: string; groups: Group[] } {
	assert.equal(msg.role, "user", "附件必须是 user 消息");
	const flat = parts(msg);
	assert.ok(flat.length > 0, "附件不能是空消息");
	assert.ok(isHeader(flat[0]), `附件首部件应是「来自工具返回」的说明文字，实际是 ${JSON.stringify(flat[0])}`);
	const header = String(flat[0].text);

	const groups: Group[] = [];
	let i = 1;
	while (i < flat.length) {
		const labelPart = flat[i];
		assert.equal(labelPart.type, "text", "每组应以文本标签开始");
		const label = String(labelPart.text);
		assert.ok(LABEL_RE.test(label), `第 ${groups.length + 1} 组应以来源标签开始，实际是 ${JSON.stringify(label)}`);

		const body: WirePart[] = [];
		i++;
		while (i < flat.length && !(flat[i].type === "text" && CLOSE_RE.test(String(flat[i].text)))) {
			body.push(flat[i]);
			i++;
		}
		assert.ok(i < flat.length, `第 ${groups.length + 1} 组缺少结束边界`);
		const closing = String(flat[i].text);
		i++;
		groups.push({ label, body, closing });
	}
	return { header, groups };
}

/** 正文的形状序列，用于断言图文交错。 */
const bodyShape = (group: Group): string[] =>
	group.body.map((p) => (p.type === "text" ? `t:${String(p.text)}` : `i:${tagOf(p as never)}`));

/**
 * 含图工具结果的 tool 消息：必须指向附件位置、带上调用 ID，且**不得重复携带正文**。
 * 「指向附件位置」用宽松正则匹配语义（attach / after），不锁定具体英文措辞。
 */
function assertGuidance(msg: WireMessage, bodyTexts: string[]): void {
	assert.equal(msg.role, "tool");
	const content = String(msg.content);
	assert.ok(content.length > 0, "tool 消息 content 不能为空（OpenAI 不允许）");
	assert.notEqual(content, "(no tool output)", "含图结果不应退化成空输出占位");
	assert.match(content, /attach|after/i, "指引应说明完整图文位于本批工具回复之后的附件块");
	assert.ok(content.includes(String(msg.tool_call_id)), "指引应包含相同的调用 ID");
	for (const body of bodyTexts) {
		assert.ok(!content.includes(body), `指引不得重复携带该结果的正文，但发现了 ${JSON.stringify(body)}`);
	}
}

/** 找到 assistant(tool_calls) 之后那批紧邻 tool 消息。 */
function toolBatchAfter(msgs: WireMessage[], assistantIndex: number): WireMessage[] {
	const batch: WireMessage[] = [];
	for (let i = assistantIndex + 1; i < msgs.length && msgs[i].role === "tool"; i++) {
		batch.push(msgs[i]);
	}
	return batch;
}

// ---------- 用例 ----------

let restore: () => void;
beforeEach(() => { restore = installMockFetch(); });
afterEach(() => { restore(); });

await test("1. 同批多个工具均返回图片：tool 连续、配对正确、附件分组正确", async () => {
	const msgs = await convert({
		messages: [
			user([txt("hi")]),
			assistantWithCalls("call_A", "call_B"),
			toolResult("call_A", [txt("bodyA"), img("imgA")], "screenshot"),
			toolResult("call_B", [txt("bodyB"), img("imgB")], "weather"),
		],
	});

	// 工具连续性：紧邻的 tool 消息数量 == tool_calls 数量，且 id 一一对上
	const batch = toolBatchAfter(msgs, 1);
	assert.equal(batch.length, 2, "assistant 后应紧邻 2 条 tool 消息");
	assert.deepEqual(
		batch.map((m) => m.tool_call_id),
		["call_A", "call_B"],
	);
	assert.equal(msgs[1].tool_calls?.length, 2);

	const att = msgs[4];
	assert.equal(att.role, "user", "附件应紧跟本批 tool 回复");
	const { header, groups } = parseAttachment(att);
	assert.ok(header.length > 0);
	assert.equal(groups.length, 2, "应有两组");

	// 来源标识必须同时含 toolName 与 toolCallId（名字里不含 id，所以两个断言互相独立）
	assert.ok(groups[0].label.includes("screenshot"), "第 1 组标签应含 toolName");
	assert.ok(groups[0].label.includes("call_A"), "第 1 组标签应含 toolCallId");
	assert.ok(groups[1].label.includes("weather"), "第 2 组标签应含 toolName");
	assert.ok(groups[1].label.includes("call_B"), "第 2 组标签应含 toolCallId");

	// 每组正文保序，图片各出现一次
	assert.deepEqual(bodyShape(groups[0]), ["t:bodyA", "i:imgA"]);
	assert.deepEqual(bodyShape(groups[1]), ["t:bodyB", "i:imgB"]);

	// 指引：指向附件、带 ID、且不重复携带正文
	assertGuidance(batch[0], ["bodyA"]);
	assertGuidance(batch[1], ["bodyB"]);
});

await test("2. 同一工具返回交错图文：附件内顺序完全保留", async () => {
	const msgs = await convert({
		messages: [
			user([txt("hi")]),
			assistantWithCalls("call_A"),
			toolResult("call_A", [txt("A1"), img("A1"), txt("A2"), img("A2"), txt("tail")], "reader"),
		],
	});
	const { groups } = parseAttachment(msgs[msgs.length - 1]);
	assert.equal(groups.length, 1);
	assert.deepEqual(
		bodyShape(groups[0]),
		["t:A1", "i:A1", "t:A2", "i:A2", "t:tail"],
		"图文交错顺序必须原样保留",
	);
	assert.deepEqual(imagesOf(msgs[msgs.length - 1]), ["A1", "A2"], "图片各出现一次");
});

await test("3. 带图结果后面跟着纯文字工具结果：不提前插 user，纯文字结果原样", async () => {
	const msgs = await convert({
		messages: [
			user([txt("hi")]),
			assistantWithCalls("call_A", "call_B"),
			toolResult("call_A", [img("imgA")], "screenshot"),
			toolResult("call_B", [txt("plainB")], "weather"),
		],
	});
	assert.deepEqual(rolesOf(msgs), ["user", "assistant", "tool", "tool", "user"]);

	const batch = toolBatchAfter(msgs, 1);
	assert.equal(batch.length, 2, "纯文字 tool 结果不得被 user 消息挤开");
	assert.equal(batch[1].tool_call_id, "call_B");
	assert.equal(batch[1].content, "plainB", "纯文字工具结果内容原样保留");

	// 含图那条只放指引，且不含任何正文
	assertGuidance(batch[0], []);

	// 纯文字结果不进附件
	const { groups } = parseAttachment(msgs[4]);
	assert.equal(groups.length, 1, "只有含图结果进附件");
	assert.ok(groups[0].label.includes("screenshot"));
	assert.deepEqual(imagesOf(msgs[4]), ["imgA"]);
});

await test("4a. 图片-only：tool 消息有指引，附件有来源和图片", async () => {
	const msgs = await convert({
		messages: [user([txt("hi")]), assistantWithCalls("call_A"), toolResult("call_A", [img("onlyA")], "reader")],
	});
	assertGuidance(msgs[2], []);
	const { groups } = parseAttachment(msgs[3]);
	assert.equal(groups.length, 1);
	assert.ok(groups[0].label.includes("reader"), "标签应含 toolName");
	assert.ok(groups[0].label.includes("call_A"), "标签应含 toolCallId");
	assert.deepEqual(bodyShape(groups[0]), ["i:onlyA"]);
});

await test("4b. 文字-only：不生成附件消息", async () => {
	const msgs = await convert({
		messages: [user([txt("hi")]), assistantWithCalls("call_A"), toolResult("call_A", [txt("just text")])],
	});
	assert.deepEqual(rolesOf(msgs), ["user", "assistant", "tool"], "不应出现附件 user");
	assert.equal(msgs[2].content, "just text");
});

await test("4c. 空结果：保留 (no tool output) 占位，且不生成空附件", async () => {
	const msgs = await convert({
		messages: [user([txt("hi")]), assistantWithCalls("call_A"), toolResult("call_A", [])],
	});
	assert.deepEqual(rolesOf(msgs), ["user", "assistant", "tool"]);
	assert.equal(msgs[2].content, "(no tool output)");
});

await test("5a. 历史在 toolResult 处结束：仍会 flush", async () => {
	const msgs = await convert({
		messages: [
			user([txt("hi")]),
			assistantWithCalls("call_A"),
			toolResult("call_A", [txt("t"), img("imgA")], "reader"),
		],
	});
	assert.equal(msgs[msgs.length - 1].role, "user", "结尾应补出附件");
	const { groups } = parseAttachment(msgs[msgs.length - 1]);
	assert.equal(groups.length, 1);
	assert.deepEqual(imagesOf(msgs[msgs.length - 1]), ["imgA"]);
});

await test("5b. 后面还有真实 user：附件出现在它之前", async () => {
	const msgs = await convert({
		messages: [
			user([txt("hi")]),
			assistantWithCalls("call_A"),
			toolResult("call_A", [img("imgA")], "reader"),
			user([txt("next question")]),
		],
	});
	assert.deepEqual(rolesOf(msgs), ["user", "assistant", "tool", "user", "user"]);
	assert.deepEqual(imagesOf(msgs[3]), ["imgA"], "第 3 条应是附件");
	assert.equal(msgs[4].content, "next question", "真实 user 应在附件之后且内容原样");
});

await test("5c. 两个工具批次：不串批、不重复", async () => {
	const msgs = await convert({
		messages: [
			user([txt("hi")]),
			assistantWithCalls("call_A"),
			toolResult("call_A", [img("first")], "reader"),
			assistantWithCalls("call_B"),
			toolResult("call_B", [img("second")], "grep"),
		],
	});
	assert.deepEqual(rolesOf(msgs), ["user", "assistant", "tool", "user", "assistant", "tool", "user"]);
	const first = parseAttachment(msgs[3]);
	const second = parseAttachment(msgs[6]);
	assert.equal(first.groups.length, 1);
	assert.equal(second.groups.length, 1);
	assert.ok(first.groups[0].label.includes("call_A"));
	assert.ok(second.groups[0].label.includes("call_B"));
	assert.deepEqual(imagesOf(msgs[3]), ["first"], "第一批附件只含 first");
	assert.deepEqual(imagesOf(msgs[6]), ["second"], "第二批附件只含 second");
});

await test("6. 普通 user 的交错图文：请求体里顺序一致", async () => {
	const msgs = await convert({
		messages: [user([txt("U1"), img("U1"), txt("U2"), img("U2")])],
	});
	assert.deepEqual(rolesOf(msgs), ["user"]);
	const shape = parts(msgs[0]).map((p) =>
		p.type === "text" ? `t:${String(p.text)}` : `i:${tagOf(p as never)}`,
	);
	assert.deepEqual(shape, ["t:U1", "i:U1", "t:U2", "i:U2"]);
});

await test("7. 输入不被修改，且重复转换结果稳定", async () => {
	const messages: Message[] = [
		user([txt("U1"), img("U1"), txt("U2")]),
		assistantWithCalls("call_A", "call_B"),
		toolResult("call_A", [txt("A1"), img("A1"), txt("A2")], "reader"),
		toolResult("call_B", [img("B")], "grep"),
	];
	const before = JSON.stringify(messages);

	const first = await convert({ messages });
	const second = await convert({ messages });
	const third = await convert({ messages });

	assert.equal(JSON.stringify(messages), before, "转换不得修改传入的 messages / content");
	assert.deepEqual(first, second, "同一上下文重复转换应得到完全相同的结果");
	assert.deepEqual(second, third, "第三次转换也不应漂移");
	assert.equal(
		first.filter((m) => m.role === "user").length,
		second.filter((m) => m.role === "user").length,
		"重复转换不得累加附件",
	);
});

await test("8. 边界成对：每组都必须有结束边界", async () => {
	const msgs = await convert({
		messages: [
			user([txt("hi")]),
			assistantWithCalls("call_A", "call_B"),
			toolResult("call_A", [txt("a"), img("a")], "reader"),
			toolResult("call_B", [txt("b"), img("b")], "grep"),
		],
	});
	const { groups } = parseAttachment(msgs[4]);
	assert.equal(groups.length, 2);
	for (const [index, group] of groups.entries()) {
		assert.ok(group.closing.startsWith("[/tool result"), `第 ${index + 1} 组结束边界缺失或格式不对`);
	}
	// 结束边界必须在该组正文之后、下一组标签之前（parseAttachment 已按此切分，这里再确认切分没吞掉内容）
	assert.deepEqual(bodyShape(groups[0]), ["t:a", "i:a"]);
	assert.deepEqual(bodyShape(groups[1]), ["t:b", "i:b"]);
});

await test("9. 三份结果都带图：分组互相不串", async () => {
	const msgs = await convert({
		messages: [
			user([txt("hi")]),
			assistantWithCalls("call_A", "call_B", "call_C"),
			toolResult("call_A", [txt("tA"), img("iA")], "alpha"),
			toolResult("call_B", [img("iB1"), img("iB2")], "beta"),
			toolResult("call_C", [txt("tC"), img("iC"), txt("tC2")], "gamma"),
		],
	});
	const batch = toolBatchAfter(msgs, 1);
	assert.equal(batch.length, 3);
	const { groups } = parseAttachment(msgs[5]);
	assert.equal(groups.length, 3);
	assert.deepEqual(bodyShape(groups[0]), ["t:tA", "i:iA"]);
	assert.deepEqual(bodyShape(groups[1]), ["i:iB1", "i:iB2"]);
	assert.deepEqual(bodyShape(groups[2]), ["t:tC", "i:iC", "t:tC2"]);
	assert.deepEqual(imagesOf(msgs[5]), ["iA", "iB1", "iB2", "iC"], "四张图顺序正确、无重复无丢失");
	for (const [name, group] of [
		["alpha", groups[0]],
		["beta", groups[1]],
		["gamma", groups[2]],
	] as const) {
		assert.ok(group.label.includes(name), `标签应含 toolName ${name}`);
	}
});
