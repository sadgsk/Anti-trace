// RFC 6570 expansion. The UI may supply scalars, lists, or associative arrays.
export type TemplateValue = string | readonly string[] | Readonly<Record<string, string>>;
const operators = {
	"":  { prefix: "",  separator: ",", named: false, empty: "",  reserved: false },
	"+": { prefix: "",  separator: ",", named: false, empty: "",  reserved: true },
	"#": { prefix: "#", separator: ",", named: false, empty: "",  reserved: true },
	".": { prefix: ".", separator: ".", named: false, empty: "",  reserved: false },
	"/": { prefix: "/", separator: "/", named: false, empty: "",  reserved: false },
	";": { prefix: ";", separator: ";", named: true,  empty: "",  reserved: false },
	"?": { prefix: "?", separator: "&", named: true,  empty: "=", reserved: false },
	"&": { prefix: "&", separator: "&", named: true,  empty: "=", reserved: false },
} as const;
type Operator = (typeof operators)[keyof typeof operators];
interface Variable { name: string; explode: boolean; limit?: number }
interface Expression { operator: Operator; variables: Variable[] }
const invalid = () => new Error("MCP 资源 URI 模板无效。");

function parse(template: string): (string | Expression)[] {
	const parts: (string | Expression)[] = [];
	for (const token of template.match(/\{[^{}]*\}|[^{}]+|[{}]/gu) ?? []) {
		if (token === "{" || token === "}") throw invalid();
		if (!token.startsWith("{")) { parts.push(token); continue; }
		let content = token.slice(1, -1);
		const key = content[0] as keyof typeof operators;
		const operator = operators[key] ?? operators[""];
		if (operator !== operators[""]) content = content.slice(1);
		const variables = content.split(",").map(part => {
			const match = /^((?:[A-Za-z0-9_]|%[\dA-Fa-f]{2})+(?:\.(?:[A-Za-z0-9_]|%[\dA-Fa-f]{2})+)*)(?:([*])|:([1-9]\d{0,3}))?$/u.exec(part);
			if (!match) throw invalid();
			return { name: match[1]!, explode: Boolean(match[2]), limit: match[3] ? Number(match[3]) : undefined };
		});
		parts.push({ operator, variables });
	}
	return parts;
}

export function templateVariables(template: string): string[] {
	return [...new Set(parse(template).flatMap(part => typeof part === "string" ? [] : part.variables.map(v => v.name)))];
}

function encode(value: string, reserved: boolean): string {
	return (value.match(/%[\da-f]{2}|[\s\S]/giu) ?? []).map(char => {
		if (reserved && (char.length === 3 && char[0] === "%" || ":/?#[]@!$&'()*+,;=".includes(char))) return char;
		return encodeURIComponent(char).replace(/[!'()*]/gu, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
	}).join("");
}

function expand(variable: Variable, value: TemplateValue, op: Operator): string[] {
	const escape = (s: string) => encode(s, op.reserved);
	const named = (key: string, s: string) => op.named ? key + (s ? "=" + s : op.empty) : s;
	if (typeof value === "string") {
		const s = variable.limit === undefined ? value : Array.from(value).slice(0, variable.limit).join("");
		return [named(variable.name, escape(s))];
	}
	if (variable.limit !== undefined) throw invalid();
	if (Array.isArray(value)) {
		const items = value.map(escape);
		if (!items.length) return [];
		return variable.explode ? items.map(s => named(variable.name, s)) : [named(variable.name, items.join(","))];
	}
	const pairs = Object.entries(value).map(([k,v]) => [escape(k), escape(v)] as const);
	if (!pairs.length) return [];
	if (!variable.explode) return [named(variable.name, pairs.flat().join(","))];
	return pairs.map(([k,v]) => op.named ? named(k, v) : k + "=" + v);
}

export function expandResourceTemplate(template: string, values: Readonly<Record<string, TemplateValue>>): string {
	return parse(template).map(part => {
		if (typeof part === "string") return encode(part, true);
		const items = part.variables.flatMap(v => Object.hasOwn(values, v.name) ? expand(v, values[v.name]!, part.operator) : []);
		return items.length ? part.operator.prefix + items.join(part.operator.separator) : "";
	}).join("");
}
