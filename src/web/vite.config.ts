import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 患者薄壳静态构建：产物输出到 dist/web/，由 src/http/server.ts 托管。
// 前端零业务逻辑，只通过 POST /v1/patient/commands 命令协议与后端交互。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true
  }
});
