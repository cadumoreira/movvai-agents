import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";
import type { Sandbox, SandboxExec } from "./types.js";

/** Executa um binário, captura stdout/stderr/exit; opcionalmente envia bytes pelo stdin. */
function exec(cmd: string, args: string[], opts?: { input?: Buffer; timeoutMs?: number }): Promise<SandboxExec> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { timeout: opts?.timeoutMs });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    p.on("error", (err) => resolve({ exitCode: -1, stdout, stderr: stderr + String(err) }));
    if (opts?.input) {
      p.stdin.write(opts.input);
      p.stdin.end();
    }
  });
}

/** Sandbox local via Docker (contêiner na sua máquina). Requer Docker instalado/rodando. */
class DockerSandbox implements Sandbox {
  readonly repoDir = "/home/user/repo";
  constructor(private readonly id: string) {}

  async run(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<SandboxExec> {
    const args = ["exec"];
    if (opts?.cwd) args.push("-w", opts.cwd);
    args.push(this.id, "bash", "-lc", command);
    return exec("docker", args, { timeoutMs: opts?.timeoutMs });
  }

  async readFile(path: string): Promise<string> {
    const r = await exec("docker", ["exec", this.id, "cat", path]);
    if (r.exitCode !== 0) throw new Error(r.stderr || `falha ao ler ${path}`);
    return r.stdout;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.writeBytes(path, Buffer.from(content, "utf-8"));
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "sbx-"));
    const tmp = join(dir, "file");
    try {
      writeFileSync(tmp, data);
      const parent = path.split("/").slice(0, -1).join("/") || "/";
      await exec("docker", ["exec", this.id, "mkdir", "-p", parent]);
      const r = await exec("docker", ["cp", tmp, `${this.id}:${path}`]);
      if (r.exitCode !== 0) throw new Error(r.stderr || `falha ao escrever ${path}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async kill(): Promise<void> {
    await exec("docker", ["rm", "-f", this.id]);
  }
}

export async function createDockerSandbox(): Promise<Sandbox> {
  const image = config.sandbox.dockerImage;
  const args = ["run", "-d", "--rm"];
  if (!config.sandbox.allowInternet) args.push("--network", "none");
  args.push(image, "sleep", "infinity");

  const r = await exec("docker", args, { timeoutMs: 120_000 });
  if (r.exitCode !== 0) {
    throw new Error(
      `Falha ao iniciar o contêiner Docker (o Docker está instalado e rodando?): ${r.stderr.trim()}`,
    );
  }
  return new DockerSandbox(r.stdout.trim());
}
