import { resolve } from "node:path";

import { createApplication } from "../app/composition-root.js";
import { DomainError } from "@kangmin/core/kernel/errors";

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

if (process.env.KANGMIN_ALLOW_DEV_SESSION !== "1") {
  process.stderr.write(
    "拒绝创建测试会话：请显式设置 KANGMIN_ALLOW_DEV_SESSION=1\n"
  );
  process.exitCode = 9;
} else {
  const subject = option(process.argv.slice(2), "--subject");
  if (subject === undefined) {
    process.stderr.write("用法：npm run dev:session -- --subject patient-a\n");
    process.exitCode = 2;
  } else {
    const databasePath = resolve(
      process.env.KANGMIN_DB_PATH ?? ".local/kangmin-mvp.sqlite"
    );
    const application = createApplication(databasePath);
    try {
      const session =
        await application.sessions.createDevelopmentSession(subject);
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          developmentOnly: true,
          sessionToken: session.token,
          expiresAt: session.expiresAt
        })}\n`
      );
    } catch (error) {
      const message =
        error instanceof DomainError ? error.message : "创建测试会话失败";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    } finally {
      application.close();
    }
  }
}
