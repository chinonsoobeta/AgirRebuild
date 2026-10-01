// Development: the API (with its embedded worker) on :8787 and Vite on :5173.
import { spawn } from "node:child_process";
const run = (args) => spawn("npm", args, { stdio: "inherit", shell: false });
const procs = [run(["run", "dev", "-w", "@agir/api"]), run(["run", "dev", "-w", "@agir/web"])];
const stop = () => procs.forEach((p) => p.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
