import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { McpError, type JsonValue } from "./types.ts";
import { atomicWrite, digest, MCP_LIMITS } from "./util.ts";
interface State { version:1; trust:Record<string,boolean>; enabled:Record<string,boolean> }
interface Credentials { version:1; entries:Record<string,{identity:string;data:Record<string,JsonValue>}> }
/** Public configuration and private account state never share a file. */
export class McpLocalState {
	constructor(readonly directory:string){}
	private read<T>(name:string,fallback:T):T {
		const path=join(this.directory,name); if(!existsSync(path))return fallback;
		try{if(statSync(path).size>MCP_LIMITS.configBytes*8)throw new Error();const v=JSON.parse(readFileSync(path,"utf8"));
			if(!v||v.version!==1||typeof v!=="object")throw new Error();return v as T;}
		catch{throw new McpError("config","MCP 私有状态无法读取，请检查用户目录中的状态文件。");}
	}
	private write(name:string,value:unknown){try{atomicWrite(join(this.directory,name),JSON.stringify(value,null,2)+"\n",true);}catch{throw new McpError("config","MCP 私有状态保存失败。");}}
	private state():State {const v=this.read<State>("state.json",{version:1,trust:{},enabled:{}}); if(!v.trust||!v.enabled||typeof v.trust!=="object"||typeof v.enabled!=="object"||Array.isArray(v.trust)||Array.isArray(v.enabled)||Object.values(v.trust).some(x=>typeof x!=="boolean")||Object.values(v.enabled).some(x=>typeof x!=="boolean"))throw new McpError("config","MCP 私有状态格式无效。");return v;}
	isTrusted(key:string){return this.state().trust[key]===true;}
	trust(key:string){const v=this.state();v.trust[key]=true;this.write("state.json",v);}
	getEnabled(key:string){return this.state().enabled[key];}
	setEnabled(key:string,enabled:boolean){const v=this.state();v.enabled[key]=enabled;this.write("state.json",v);}
	private credentials():Credentials {
		const v=this.read<Credentials>("credentials.json",{version:1,entries:{}});
		if(!v.entries||typeof v.entries!=="object"||Array.isArray(v.entries)||Object.values(v.entries).some(entry=>!entry||typeof entry.identity!=="string"||!entry.data||typeof entry.data!=="object"||Array.isArray(entry.data)))throw new McpError("config","MCP 凭据文件格式无效。");
		return v;
	}
	getCredentials(key:string){const v=this.credentials().entries[key];return v?structuredClone(v):undefined;}
	updateCredentials(key:string,update:(data:Record<string,JsonValue>)=>Record<string,JsonValue>,newIdentity=false):string {
		const all=this.credentials(),previous=all.entries[key]; const identity=newIdentity||!previous?randomUUID():previous.identity;
		all.entries[key]={identity,data:update(previous?.data??{})};this.write("credentials.json",all);return identity;
	}
	logout(key:string){this.updateCredentials(key,()=>({}),true);}
	static scopeKey(project:string,id:string){return digest({project,id});}
}
