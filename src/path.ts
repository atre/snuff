import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Resolve a tool on PATH via accessSync(X_OK) — no `which` subprocess. */
export function onPath(tool: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        accessSync(join(dir, tool + ext), constants.X_OK);
        return true;
      } catch {
        // not here — try the next PATH entry
      }
    }
  }
  return false;
}
