import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

const isServerBuild = process.env.SERVER_BUILD === "1";

export default defineConfig({
  base: "/",
  publicDir: isServerBuild ? false : "public",
  plugins: [vue()],
  server: {
    headers: isolationHeaders,
  },
  preview: {
    headers: isolationHeaders,
  },
  worker: {
    format: "es",
  },
});
