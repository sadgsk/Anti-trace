import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { getAppPaths, type AppPaths } from "../storage/app-paths.ts";
import { McpError, type McpAuth, type McpConfigCandidate, type McpConfigDocument, type McpScope, type McpServerConfig, type McpServerDefinition } from "../mcp/types.ts";
import { atomicWrite, digest, freeze, MCP_LIMITS } from "../mcp/util.ts";

const commonKeys = ["type", "enabled", "startupTimeoutMs", "requestTimeoutMs", "outputMaxBytes", "enabledTools", "disabledTools"];
const bad = (path: string, detail: string): never => { throw new McpError("config", `MCP 配置 ${path}：${detail}`); };
function object(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return bad(path, "应为对象。");
	return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], path: string) {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) bad(`${path}/${key.replace(/[^\w.-]/g, "?")}`, "未知字段。");
}
function string(value: unknown, path: string, empty = false): string {
	if (typeof value !== "string" || (!empty && !value.trim()) || value.includes("\0")) return bad(path, "应为有效字符串。");
	return value;
}
function strings(value: unknown, path: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return bad(path, "应为字符串数组。");
	return value.map((v,i) => string(v, `${path}/${i}`));
}
function map(value: unknown, path: string): Record<string, string> {
	if (value === undefined) return {};
	return Object.fromEntries(Object.entries(object(value,path)).map(([k,v]) => {
		if (!k || /[\r\n\0]/.test(k)) bad(path,"映射键无效。");
		return [k,string(v,`${path}/${k}`,true)];
	}));
}
function integer(value: unknown, fallback: number, path: string, max = 2147483647): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) return bad(path,"应为范围内的正整数。");
	return value;
}
function envName(value: string, path: string): string { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) bad(path,"环境变量名无效。"); return value; }
function parseAuth(value: unknown, path: string): McpAuth {
	if (value === undefined) return { type: "none" };
	const v=object(value,path);
	if (v.type === "none") { keys(v,["type"],path); return {type:"none"}; }
	if (v.type === "bearer") { keys(v,["type","tokenEnv"],path); return {type:"bearer",tokenEnv:envName(string(v.tokenEnv,`${path}/tokenEnv`),path)}; }
	if (v.type !== "oauth") return bad(`${path}/type`,"应为 none、bearer 或 oauth。");
	keys(v,["type","clientId","clientSecretEnv","scopes","callbackPort"],path);
	const clientId=v.clientId === undefined ? undefined : string(v.clientId,`${path}/clientId`);
	const clientSecretEnv=v.clientSecretEnv === undefined ? undefined : envName(string(v.clientSecretEnv,`${path}/clientSecretEnv`),path);
	if(clientSecretEnv && !clientId) bad(path,"预注册客户端密钥需要 clientId。");
	const scopes=v.scopes === undefined ? undefined : strings(v.scopes,`${path}/scopes`);
	if(scopes?.some(s=>/\s/.test(s))) bad(`${path}/scopes`,"每个 scope 应为单个值。");
	return {type:"oauth",...(clientId?{clientId}:{}),...(clientSecretEnv?{clientSecretEnv}:{}),...(scopes?{scopes}:{}),
		...(v.callbackPort===undefined?{}:{callbackPort:integer(v.callbackPort,0,`${path}/callbackPort`,65535)})};
}
export function parseMcpConfig(text: string, source = "mcp.json"): McpConfigDocument {
	if(Buffer.byteLength(text)>MCP_LIMITS.configBytes) bad(source,"配置文件超过大小上限。");
	let raw: unknown;
	try { raw=JSON.parse(text.replace(/^\uFEFF/,"")); } catch { return bad(source,"不是有效的 JSON。"); }
	const doc=object(raw,source); keys(doc,["version","mcpServers"],source);
	if(doc.version !== undefined && doc.version !== 1) bad(`${source}/version`,"只支持版本 1。");
	const entries=object(doc.mcpServers,`${source}/mcpServers`);
	if(Object.keys(entries).length>128) bad(source,"最多配置 128 个服务器。");
	const servers: Record<string,McpServerConfig>=Object.create(null);
	for(const [id,rawServer] of Object.entries(entries)) {
		if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id) || ["__proto__","constructor","prototype"].includes(id)) bad(`${source}/mcpServers`,"服务器名称只允许字母、数字、点、横线和下划线，最长 128 字符。");
		const path=`${source}/mcpServers/${id}`, v=object(rawServer,path), type=v.type??"stdio";
		if(type!=="stdio"&&type!=="http") bad(`${path}/type`,"应为 stdio 或 http。");
		keys(v,[...commonKeys,...(type==="stdio"?["command","args","cwd","env","envVars"]:["url","headers","envHeaders","auth"])],path);
		if(v.enabled!==undefined&&typeof v.enabled!=="boolean") bad(`${path}/enabled`,"应为布尔值。");
		const common={ enabled:v.enabled as boolean??true,startupTimeoutMs:integer(v.startupTimeoutMs,10000,`${path}/startupTimeoutMs`),
			requestTimeoutMs:integer(v.requestTimeoutMs,60000,`${path}/requestTimeoutMs`),outputMaxBytes:integer(v.outputMaxBytes,32768,`${path}/outputMaxBytes`,MCP_LIMITS.messageBytes),
			...(v.enabledTools===undefined?{}:{enabledTools:strings(v.enabledTools,`${path}/enabledTools`)}),disabledTools:strings(v.disabledTools,`${path}/disabledTools`) };
		if(type==="stdio") {
			const env=map(v.env,`${path}/env`); for(const key of Object.keys(env)) envName(key,`${path}/env`);
			servers[id]={...common,type,command:string(v.command,`${path}/command`),args:strings(v.args,`${path}/args`),
				...(v.cwd===undefined?{}:{cwd:string(v.cwd,`${path}/cwd`)}),env,envVars:strings(v.envVars,`${path}/envVars`).map(n=>envName(n,path))};
		} else {
			const url=string(v.url,`${path}/url`); let parsed: URL;
			try { parsed=new URL(url); } catch { return bad(`${path}/url`,"URL 无效。"); }
			if(!["http:","https:"].includes(parsed.protocol)||parsed.username||parsed.password||parsed.hash) bad(`${path}/url`,"需要不含用户凭据和片段的 HTTP(S) URL。");
			const headers=map(v.headers,`${path}/headers`),envHeaders=map(v.envHeaders,`${path}/envHeaders`),seen=new Set<string>();
			for(const [key,val] of [...Object.entries(headers),...Object.entries(envHeaders)]) {
				if(!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key)||/[\r\n]/.test(val)||seen.has(key.toLowerCase())) bad(`${path}/headers`,"请求头名称、值或重复定义无效。");
				if(["host","content-length","mcp-session-id","mcp-protocol-version"].includes(key.toLowerCase())) bad(`${path}/headers`,"该请求头由连接层管理。");
				seen.add(key.toLowerCase());
			}
			for(const name of Object.values(envHeaders)) envName(name,`${path}/envHeaders`);
			const auth=parseAuth(v.auth,`${path}/auth`);
			if(auth.type!=="none"&&seen.has("authorization")) bad(`${path}/auth`,"Authorization 只能有一个来源。");
			servers[id]={...common,type:"http",url:parsed.href,headers,envHeaders,auth};
		}
	}
	return {version:1,mcpServers:servers};
}
function readConfig(path:string):{document:McpConfigDocument;digest:string} {
	if(!existsSync(path))return {document:{version:1,mcpServers:{}},digest:digest("")};
	try { if(statSync(path).size>MCP_LIMITS.configBytes) bad(path,"配置文件超过大小上限。"); const text=readFileSync(path,"utf8"); return {document:parseMcpConfig(text,path),digest:digest(text)}; }
	catch(e){if(e instanceof McpError)throw e;return bad(path,"无法读取文件。");}
}
export class McpConfigStore {
	readonly cwd:string; readonly paths:Record<McpScope,string>; readonly stateDirectory:string;
	constructor(cwd:string,paths:AppPaths=getAppPaths({cwd})) {
		this.cwd=paths.cwd;
		this.paths={user:paths.mcpConfigFile,project:paths.projectMcpConfigFile};this.stateDirectory=paths.mcpStateDir;
	}
	load():McpConfigCandidate {
		const user=readConfig(this.paths.user),project=readConfig(this.paths.project);
		return this.candidate({user:user.document,project:project.document},{user:user.digest,project:project.digest});
	}
	private candidate(documents:Record<McpScope,McpConfigDocument>,digests:Record<McpScope,string>):McpConfigCandidate {
		const merged=new Map<string,McpServerDefinition>();
		for(const scope of ["user","project"] as const)for(const [id,stored]of Object.entries(documents[scope].mcpServers)) {
			const config=structuredClone(stored),path=this.paths[scope];
			if(config.type==="stdio") { config.cwd=config.cwd?resolve(dirname(path),config.cwd):this.cwd;
				if(!isAbsolute(config.command)&&/[\\/]/.test(config.command))config.command=resolve(dirname(path),config.command); }
			const {enabled,enabledTools,disabledTools,startupTimeoutMs,requestTimeoutMs,outputMaxBytes,...execution}=config;
			const source={scope,path}; const trustKey=digest({project:this.cwd,source,id,execution});
			merged.set(id,{id,config,source,...(merged.has(id)?{overridden:merged.get(id)!.source}:{}),trustKey,configKey:digest({source,id,config})});
		}
		return freeze({servers:[...merged.values()],documents,digests,paths:{...this.paths}});
	}
	/** Validate both layers and detect external edits before replacing either file. */
	save(scope:McpScope,id:string,value:unknown|undefined,expectedDigest?:string):McpConfigCandidate {
		const current=this.load();if(expectedDigest!==undefined&&current.digests[scope]!==expectedDigest)throw new McpError("config","MCP 配置已被其他程序修改，请重新打开。");
		const document=structuredClone(current.documents[scope]);
		if(value===undefined)delete document.mcpServers[id];else Object.defineProperty(document.mcpServers,id,{value,enumerable:true,writable:true,configurable:true});
		const text=JSON.stringify(document,null,2)+"\n";
		const parsed=parseMcpConfig(text,this.paths[scope]);
		const candidate=this.candidate({...current.documents,[scope]:parsed},{...current.digests,[scope]:digest(text)});
		try { atomicWrite(this.paths[scope],text); }catch{throw new McpError("config","MCP 配置保存失败。");}
		return candidate;
	}
}
