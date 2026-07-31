import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAdminApplication } from "../app/admin-composition-root.js";
import { createApplication } from "../app/composition-root.js";
import type { CommandResult } from "../kernel/result.js";
import type { AdminArticle } from "../modules/admin/content-admin-repository.js";

// 测试进程以本地开发模式启动：未配置 KANGMIN_ENCRYPTION_KEYS 时，
// 组合根按 KANGMIN_ALLOW_DEV_SESSION=1 降级为 PlaintextEncryption
//（keyVersion=plaintext-dev），并随子进程环境传播到 CLI 测试。
process.env.KANGMIN_ALLOW_DEV_SESSION = "1";


const here=dirname(fileURLToPath(import.meta.url));
const adminCli=join(here,"../cli/kangmin-admin.js");
const adminSessionCli=join(here,"../dev/create-admin-session.js");
function dataOf<T>(result:CommandResult):T { if(!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`); return result.data as T; }
async function fixture(){const directory=mkdtempSync(join(tmpdir(),"kangmin-admin-"));const databasePath=join(directory,"content.sqlite");const admin=createAdminApplication(databasePath);const session=await admin.sessions.createDevelopmentSession("owner-a");// 分类统一（评审 A P1-6）：create 校验 category 必须存在于 content_categories。
for(const name of ["鼻健康","科普"]){const result=await admin.execute({command:"content category create",adminToken:session.token,input:{name,kind:"article"}});if(!result.ok)assert.fail(`${result.error.code}: ${result.error.message}`);}return{databasePath,admin,token:session.token};}

test("管理员文章从草稿到发布再下架，与 Browse 共用真实门禁",async()=>{
  const {databasePath,admin,token}=await fixture();
  try{
    const created=dataOf<AdminArticle>(await admin.execute({command:"content article create",adminToken:token,input:{title:"换季鼻健康",category:"鼻健康",idempotencyKey:"article-1"}}));
    assert.equal(created.status,"draft");
    const invalid=await admin.execute({command:"content article publish",adminToken:token,input:{id:created.id,expectedRevision:1,yes:true}});
    assert.equal(invalid.ok,false); if(!invalid.ok)assert.equal(invalid.error.code,"validation_failed");
    const invalidUnpublish=await admin.execute({command:"content article unpublish",adminToken:token,input:{id:created.id,expectedRevision:1,yes:true}});
    assert.equal(invalidUnpublish.ok,false); if(!invalidUnpublish.ok)assert.equal(invalidUnpublish.error.code,"validation_failed");
    const stillDraft=dataOf<AdminArticle>(await admin.execute({command:"content article show",adminToken:token,input:{id:created.id}}));assert.equal(stillDraft.status,"draft");assert.equal(stillDraft.revision,1);
    const updated=dataOf<AdminArticle>(await admin.execute({command:"content article update",adminToken:token,input:{id:created.id,expectedRevision:1,summary:"科普摘要",body:"已审核科普正文",source:"客户已审核来源"}}));assert.equal(updated.revision,2);
    const noConfirm=await admin.execute({command:"content article publish",adminToken:token,input:{id:created.id,expectedRevision:2}});assert.equal(noConfirm.ok,false);if(!noConfirm.ok)assert.equal(noConfirm.error.code,"confirmation_required");
    const published=dataOf<AdminArticle>(await admin.execute({command:"content article publish",adminToken:token,input:{id:created.id,expectedRevision:2,yes:true}}));assert.equal(published.status,"published");assert.equal(published.revision,3);
    const patient=createApplication(databasePath);try{const visible=await patient.execute({command:"browse article show",input:{id:created.id}});assert.equal(visible.ok,true);}finally{patient.close();}
    const unpublished=dataOf<AdminArticle>(await admin.execute({command:"content article unpublish",adminToken:token,input:{id:created.id,expectedRevision:3,yes:true}}));assert.equal(unpublished.status,"unpublished");
    const patientAfter=createApplication(databasePath);try{const hidden=await patientAfter.execute({command:"browse article show",input:{id:created.id}});assert.equal(hidden.ok,false);if(!hidden.ok)assert.equal(hidden.error.code,"resource_not_found");}finally{patientAfter.close();}
  }finally{admin.close();}
});

test("管理身份、幂等、版本和重启恢复保持边界",async()=>{
  const {databasePath,admin,token}=await fixture();
  const input={title:"文章",category:"科普",summary:"摘要",body:"正文",source:"来源",idempotencyKey:"same"};
  const unauth=await admin.execute({command:"content article list"});assert.equal(unauth.ok,false);
  const forged=await admin.execute({command:"content article list",adminToken:token,input:{role:"owner"}});assert.equal(forged.ok,false);if(!forged.ok)assert.equal(forged.error.code,"permission_denied");
  const first=dataOf<AdminArticle>(await admin.execute({command:"content article create",adminToken:token,input}));
  const replay=dataOf<AdminArticle>(await admin.execute({command:"content article create",adminToken:token,input}));assert.equal(replay.id,first.id);
  const conflict=await admin.execute({command:"content article create",adminToken:token,input:{...input,title:"另一篇"}});assert.equal(conflict.ok,false);if(!conflict.ok)assert.equal(conflict.error.code,"idempotency_conflict");
  const update=await admin.execute({command:"content article update",adminToken:token,input:{id:first.id,expectedRevision:1,title:"新标题"}});assert.equal(update.ok,true);
  const stale=await admin.execute({command:"content article update",adminToken:token,input:{id:first.id,expectedRevision:1,title:"迟到标题"}});assert.equal(stale.ok,false);if(!stale.ok)assert.equal(stale.error.code,"version_conflict");
  admin.close();const restarted=createAdminApplication(databasePath);try{const shown=await restarted.execute({command:"content article show",adminToken:token,input:{id:first.id}});assert.equal(dataOf<AdminArticle>(shown).title,"新标题");}finally{restarted.close();}
});

test("真实 kangmin-admin CLI 使用独立令牌，生产禁用开发管理会话",async()=>{
  const {databasePath,admin,token}=await fixture();admin.close();
  const run=spawnSync(process.execPath,[adminCli,"content","article","create","--title","命令行文章","--category","科普","--summary","摘要","--body","正文","--source","来源","--idempotency-key","cli-1","--json"],{encoding:"utf8",env:{...process.env,KANGMIN_DB_PATH:databasePath,KANGMIN_ADMIN_TOKEN:token}});assert.equal(run.status,0,run.stderr);assert.equal(run.stdout.trim().split("\n").length,1);
  const denied=spawnSync(process.execPath,[adminSessionCli,"--subject","owner-prod"],{encoding:"utf8",env:{...process.env,KANGMIN_DB_PATH:databasePath,KANGMIN_APP_ENV:"production",KANGMIN_ALLOW_DEV_ADMIN_SESSION:"1"}});assert.equal(denied.status,9);assert.match(denied.stderr,/拒绝/u);
});
