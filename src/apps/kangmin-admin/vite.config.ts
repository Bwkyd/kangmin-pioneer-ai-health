import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolve } from "node:path";

// 管理后台独立小壳：产物仍输出到统一 dist/web/，由 HTTP 壳托管。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, "index.html")
    }
  }
});
