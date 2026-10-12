import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    env: { XDG_CONFIG_HOME: fileURLToPath(new URL("./coverage/xdg", import.meta.url)) },
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/cli.tsx", "src/ui/**"],
      reporter: ["text-summary", "json-summary"],
    },
  },
})
