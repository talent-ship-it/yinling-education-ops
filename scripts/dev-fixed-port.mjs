import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = 3001;
const HOST = "localhost";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = join(root, "node_modules", ".bin", process.platform === "win32" ? "vinext.cmd" : "vinext");

async function assertPortFree() {
  await new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.once("listening", () => server.close(resolve));
    server.listen(PORT, HOST);
  });
}

try {
  await assertPortFree();
} catch (error) {
  if (error?.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the old dev server before starting this one.`);
    console.error(`Check with: lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
    process.exit(1);
  }

  throw error;
}

const child = spawn(bin, ["dev", "--port", String(PORT)], {
  env: { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
