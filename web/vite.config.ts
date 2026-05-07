import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    tsconfigPaths: true,
  },
  environments: {
    ssr: {
      build: {
        // Keep the SSR server as one file: split chunks produced a circular
        // generated helper import (`__exportAll is not a function`) at startup.

        rollupOptions: {
          output: {
            codeSplitting: false,
          },
        },
      },
    },
  },
});
