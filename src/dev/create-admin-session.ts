import { resolve } from "node:path";
import { createAdminApplication } from "../app/admin-composition-root.js";
const args=process.argv.slice(2); const subjectIndex=args.indexOf("--subject");
const subject=subjectIndex === -1 ? undefined : args[subjectIndex+1];
const environment=process.env.KANGMIN_APP_ENV ?? "production";
if(process.env.KANGMIN_ALLOW_DEV_ADMIN_SESSION !== "1" || !["local","integration"].includes(environment)){process.stderr.write("拒绝创建开发管理员会话\n");process.exitCode=9;}
else if(subject === undefined){process.stderr.write("需要 --subject\n");process.exitCode=2;}
else { const app=createAdminApplication(resolve(process.env.KANGMIN_DB_PATH ?? ".local/kangmin-mvp.sqlite")); try { const session=await app.sessions.createDevelopmentSession(subject); process.stdout.write(`${JSON.stringify({ok:true,developmentOnly:true,adminToken:session.token,expiresAt:session.expiresAt})}\n`); } finally { app.close(); } }
