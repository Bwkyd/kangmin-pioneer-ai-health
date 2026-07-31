#!/usr/bin/env node
import { resolve } from "node:path";
import { createAdminApplication } from "../app/admin-composition-root.js";
import { exitCodeForCode } from "../kernel/errors.js";

const HELP = `抗敏先锋管理 CLI\n\ncontent article create|list|show|update|preview|publish|unpublish\n身份通过 KANGMIN_ADMIN_TOKEN 传递；发布/下架需要 --yes。\n`;
const names: Record<string,string> = { "--title":"title","--category":"category","--summary":"summary","--body":"body","--source":"source","--idempotency-key":"idempotencyKey","--expected-revision":"expectedRevision" };
function parse(argv: string[]) {
  const json = argv.includes("--json"); const tokens = argv.filter((x) => x !== "--json");
  if (tokens.includes("--help") || tokens.includes("-h")) return { help:true, json, command:"help", input:{} as Record<string,unknown> };
  const [group,resource,action,positional,...rest] = tokens; const command=[group,resource,action].filter(Boolean).join(" "); const input:Record<string,unknown>={};
  let options = [positional,...rest].filter((x):x is string => x !== undefined);
  if (["show","update","preview","publish","unpublish"].includes(action ?? "")) { const id=options.shift(); if (id === undefined || id.startsWith("--")) input.__parseError=`${command} 需要文章 ID`; else input.id=id; }
  for (let i=0;i<options.length;) { const token=options[i]!; if (token === "--yes") { input.yes=true; i++; continue; } const key=names[token], value=options[i+1]; if (key === undefined || value === undefined || value.startsWith("--")) { input.__parseError=`无效或缺少值的参数：${token}`; break; } input[key]=key === "expectedRevision" ? Number(value) : value; i+=2; }
  return { help:false,json,command,input };
}
export async function runAdminCli(argv:string[], env:NodeJS.ProcessEnv=process.env) {
  const parsed=parse(argv); if(parsed.help){process.stdout.write(HELP);return 0;} if(typeof parsed.input.__parseError === "string"){const body={ok:false,error:{code:"command_invalid",message:parsed.input.__parseError}}; (parsed.json?process.stdout:process.stderr).write(`${parsed.json?JSON.stringify(body):parsed.input.__parseError}\n`);return 2;}
  let app; try { app=createAdminApplication(resolve(env.KANGMIN_DB_PATH ?? ".local/kangmin-mvp.sqlite")); } catch { return 6; }
  try { const result=await app.execute({command:parsed.command,input:parsed.input,adminToken:env.KANGMIN_ADMIN_TOKEN}); if(parsed.json)process.stdout.write(`${JSON.stringify(result)}\n`); else (result.ok?process.stdout:process.stderr).write(`${JSON.stringify(result.ok?result.data:result.error,null,2)}\n`); return result.ok?0:exitCodeForCode(result.error.code); } finally { app.close(); }
}
process.exitCode=await runAdminCli(process.argv.slice(2));
