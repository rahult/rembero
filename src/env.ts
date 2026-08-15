import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

/**
 * Load .env from the current directory and from the package root (so the CLI
 * works no matter where it is launched from). Existing env vars win.
 */
export function loadEnv(): void {
  const candidates = [
    join(process.cwd(), '.env'),
    join(dirname(fileURLToPath(import.meta.url)), '..', '.env'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) config({ path, quiet: true });
  }
}
