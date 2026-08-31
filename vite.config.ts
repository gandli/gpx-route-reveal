import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "./",
  build: { target: "es2022" },
  server: { host: true },
  plugins: [tailwindcss()],
});
