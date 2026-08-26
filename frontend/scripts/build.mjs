import fs from "node:fs/promises";

// Cloudflare Pages serves static files. This build deliberately avoids bundling:
// it recreates dist/ and copies the reviewed HTML/CSS/JS source into it.
await fs.rm(new URL("../dist", import.meta.url), {
  recursive: true,
  force: true,
});
await fs.cp(
  new URL("../src", import.meta.url),
  new URL("../dist", import.meta.url),
  { recursive: true },
);
console.log("Frontend copied to frontend/dist");
