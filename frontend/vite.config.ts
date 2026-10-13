import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execSync } from "node:child_process";

function gitShort(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "dev";
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.VITE_BACKEND_URL || "http://127.0.0.1:8001";
  const buildId = `${gitShort()}-${Date.now().toString(36)}`;

  return {
    define: {
      __KAFI_BUILD_ID__: JSON.stringify(buildId),
    },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "kafi-build-meta",
        transformIndexHtml(html) {
          return html.replace(
            "</head>",
            `  <meta name="kafi-build" content="${buildId}" />\n  </head>`,
          );
        },
      },
    ],
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
