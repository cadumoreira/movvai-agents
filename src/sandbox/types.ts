/** Interface comum de sandbox: local (host), Docker, ou E2B (nuvem). */

export interface SandboxExec {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Sandbox {
  /** Diretório raiz do repositório dentro deste sandbox (varia por backend). */
  readonly repoDir: string;
  run(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<SandboxExec>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  kill(): Promise<void>;
}
