import { Sandbox as E2BClient } from "e2b";
import { config } from "../config.js";
import type { Sandbox, SandboxExec } from "./types.js";

/** Sandbox na nuvem via E2B (microVM Firecracker). */
class E2BSandbox implements Sandbox {
  readonly repoDir = "/home/user/repo";
  constructor(private readonly sbx: E2BClient) {}

  async run(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<SandboxExec> {
    try {
      const r = await this.sbx.commands.run(command, { cwd: opts?.cwd, timeoutMs: opts?.timeoutMs });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    } catch (err) {
      const e = err as { exitCode?: number; stdout?: string; stderr?: string };
      return { exitCode: e.exitCode ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(err) };
    }
  }

  async readFile(path: string): Promise<string> {
    return this.sbx.files.read(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.sbx.files.write(path, content);
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    await this.sbx.files.write(path, ab);
  }

  async kill(): Promise<void> {
    await this.sbx.kill();
  }
}

export async function createE2BSandbox(): Promise<Sandbox> {
  if (!config.e2b.apiKey) throw new Error("E2B_API_KEY não configurado.");
  const sbx = await E2BClient.create({
    apiKey: config.e2b.apiKey,
    allowInternetAccess: config.sandbox.allowInternet,
  });
  return new E2BSandbox(sbx);
}
