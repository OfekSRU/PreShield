import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/** Default model: separate free-tier pool from gemini-2.0-flash. Override with GEMINI_MODEL in .env */
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";

const geminiProxy = (env) => {
  const key = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  const legacyModel = env.GEMINI_MODEL || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  return {
    "/api/gemini": {
      target: "https://generativelanguage.googleapis.com",
      changeOrigin: true,
      rewrite: (path) => {
        let p = path.replace(/^\/api\/gemini/, "") || "";
        if (p === "/generateContent" || p === "/generateContent/" || p === "" || p === "/") {
          p = `/v1beta/models/${legacyModel}:generateContent`;
        }
        const qs = key ? `?key=${encodeURIComponent(key)}` : "";
        return `${p}${qs}`;
      },
    },
  };
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react()],
    server: {
      port: 8080,
      strictPort: true,
      proxy: geminiProxy(env),
    },
    preview: {
      port: 8080,
      strictPort: true,
      proxy: geminiProxy(env),
    },
  };
});
