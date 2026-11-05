import { spawn } from "node:child_process";

// Shopify CLI provides the same authenticated development environment to both
// processes. The worker never depends on an open dashboard or browser session.
// Windows only runs npm.cmd through a shell; the command is a fixed literal.
const web = { stdio: "inherit", env: process.env };
const processes = [
  process.platform === "win32"
    ? spawn("npm exec react-router dev", { ...web, shell: true })
    : spawn("npm", ["exec", "react-router", "dev"], web),
  spawn(
    process.execPath,
    [
      "--watch",
      "--env-file-if-exists=.env",
      "--import",
      "tsx",
      "scripts/worker.ts",
    ],
    { stdio: "inherit", env: process.env },
  ),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of processes) child.kill("SIGTERM");
}
for (const child of processes) {
  child.on("error", () => stop(1));
  child.on("exit", (code) => stop(code ?? 0));
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
