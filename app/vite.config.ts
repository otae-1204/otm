import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Tauri 用相对路径加载打包后的资源
  base: "./",
  server: {
    port: 5173,
  },
});
