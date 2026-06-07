import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Sandbox, SandboxExec } from "./types.js";

/**
 * Sandbox LOCAL: o Dev trabalha direto na sua máquina, num diretório temporário
 * descartável (criado por tarefa, apagado ao fim) — como um dev numa workstation limpa.
 *
 * ⚠️ Sem isolamento de processo: os comandos rodam no host com suas permissões. Use só
 * em ambiente confiável (sua máquina, repo de teste). Para isolamento real, use Docker
 * (SANDBOX_PROVIDER=docker) ou E2B (microVM).
 */
class LocalSandbox implements Sandbox {
  readonly repoDir: string;
  constructor(private readonly root: string) {
    this.repoDir = join(root, "repo");
  }

  run(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<SandboxExec> {
    return new Promise((resolve) => {
      const p = spawn("bash", ["-lc", command], { cwd: opts?.cwd, timeout: opts?.timeoutMs });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d.toString()));
      p.stderr.on("data", (d) => (stderr += d.toString()));
      p.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
      p.on("error", (err) => resolve({ exitCode: -1, stdout, stderr: stderr + String(err) }));
    });
  }

  async readFile(path: string): Promise<string> {
    return readFileSync(path, "utf-8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  }

  async kill(): Promise<void> {
    rmSync(this.root, { recursive: true, force: true });
  }
}

export async function createLocalSandbox(): Promise<Sandbox> {
  const root = mkdtempSync(join(tmpdir(), "movvai-"));
  return new LocalSandbox(root);
}
