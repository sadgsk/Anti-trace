import { Check } from "typebox/schema";
import type { JsonObject, JsonValue } from "./types.ts";

const scalarTypes = { enum: ["null", "boolean", "number", "integer", "string", "object", "array"] };
const strings = { type: "array", items: { type: "string" }, uniqueItems: true };
const nonnegative = { type: "integer", minimum: 0 };
const shape = {
	type: "object",
	properties: {
		type: { anyOf: [scalarTypes, { type: "array", minItems: 1, uniqueItems: true, items: scalarTypes }] },
		required: strings, enum: { type: "array", minItems: 1, uniqueItems: true },
		dependentRequired: { type: "object", additionalProperties: strings },
		minLength: nonnegative, maxLength: nonnegative, minItems: nonnegative, maxItems: nonnegative,
		minProperties: nonnegative, maxProperties: nonnegative, minContains: nonnegative, maxContains: nonnegative,
		minimum: { type: "number" }, maximum: { type: "number" }, exclusiveMinimum: { type: "number" }, exclusiveMaximum: { type: "number" },
		multipleOf: { type: "number", exclusiveMinimum: 0 }, uniqueItems: { type: "boolean" },
		pattern: { type: "string" }, format: { type: "string" }, description: { type: "string" }, title: { type: "string" },
		$schema: { enum: ["https://json-schema.org/draft/2020-12/schema", "http://json-schema.org/draft-07/schema#"] },
	},
};
const maps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const lists = new Set(["anyOf", "allOf", "oneOf", "prefixItems"]);
const single = new Set(["additionalProperties", "propertyNames", "unevaluatedProperties", "items", "additionalItems", "unevaluatedItems", "contains", "not", "if", "then", "else"]);

/** Validate schema keywords only at schema positions. User data in const/default/examples may contain arbitrary keys. */
export function verifyToolSchema(root: JsonObject): void {
	if (root.type !== "object") throw new Error("工具参数必须使用 object schema。");
	if (Buffer.byteLength(JSON.stringify(root)) > 128 * 1024) throw new Error("工具 schema 超过 128 KiB。");
	const active = new Set<JsonObject>(), done = new Set<JsonObject>();
	function visit(value: JsonValue, depth: number): void {
		if (typeof value === "boolean") return;
		if (!value || typeof value !== "object" || Array.isArray(value) || !Check(shape, value)) throw new Error("工具 JSON Schema 字段无效。");
		if (depth > 64 || active.has(value)) throw new Error("不支持循环引用或过深的工具 schema。");
		if (done.has(value)) return;
		active.add(value);
		for (const [key, child] of Object.entries(value)) {
			if (maps.has(key)) {
				if (!child || typeof child !== "object" || Array.isArray(child)) throw new Error("无效的 schema 映射: " + key);
				for (const [name, node] of Object.entries(child)) {
					if (key === "patternProperties") new RegExp(name, "u");
					visit(node, depth + 1);
				}
			} else if (lists.has(key) || (key === "items" && Array.isArray(child))) {
				if (!Array.isArray(child) || !child.length) throw new Error("无效的 schema 列表: " + key);
				for (const node of child) visit(node, depth + 1);
			} else if (single.has(key)) visit(child, depth + 1);
			else if (key === "pattern") new RegExp(String(child), "u");
			else if (key === "$ref") {
				if (typeof child !== "string" || !child.startsWith("#/")) throw new Error("工具 schema 仅支持本地 JSON Pointer 引用。");
				let target: JsonValue = root;
				for (const part of decodeURIComponent(child.slice(2)).split("/")) {
					const name = part.replace(/~1/g, "/").replace(/~0/g, "~");
					if (!target || typeof target !== "object" || !Object.hasOwn(target, name)) throw new Error("无法解析 schema 引用。");
					target = (target as JsonObject)[name];
				}
				visit(target, depth + 1);
			} else if (key.startsWith("$") && !["$schema", "$comment"].includes(key)) {
				throw new Error("不支持的 schema 关键字: " + key);
			} else if (key === "dependencies") {
				if (!child || typeof child !== "object" || Array.isArray(child)) throw new Error("无效的 dependencies。");
				for (const node of Object.values(child)) {
					if (Array.isArray(node) && Check(strings, node)) continue;
					visit(node, depth + 1);
				}
			}
		}
		active.delete(value);
		done.add(value);
	}
	visit(root, 0);
}
