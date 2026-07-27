/**
 * Reproduces the User-Agent the codex Rust CLI sends.
 *
 * The endpoint rejects clients it does not recognise, so this string has to
 * match `codex_cli_rs`'s format exactly — including the terminal suffix, which
 * codex derives from the same environment variables.
 */

import { release } from "node:os";

export const DEFAULT_CODEX_VERSION = "0.143.0";
export const CODEX_ORIGINATOR = "codex_cli_rs";

function mapPlatform(platform: string): string {
  switch (platform) {
    case "darwin":
      return "Mac OS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    case "freebsd":
      return "FreeBSD";
    default:
      return platform;
  }
}

function mapArch(arch: string): string {
  switch (arch) {
    case "x64":
      return "x86_64";
    default:
      return arch;
  }
}

function terminalUserAgent(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TERM_PROGRAM) {
    const version = env.TERM_PROGRAM_VERSION;
    return `${env.TERM_PROGRAM}${version ? ` ${version}` : ""}`.trim();
  }
  if (env.WT_SESSION) return "WindowsTerminal";
  if (env.KITTY_WINDOW_ID) return "kitty";
  if (env.TMUX) return "tmux";
  if (env.TERM && env.TERM !== "dumb") return env.TERM;
  return "unknown";
}

export function buildCodexUserAgent(version = DEFAULT_CODEX_VERSION): string {
  return `${CODEX_ORIGINATOR}/${version} (${mapPlatform(process.platform)} ${release()}; ${mapArch(process.arch)}) ${terminalUserAgent()}`;
}
