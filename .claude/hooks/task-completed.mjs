// Thin launcher: the implementation lives in src/hooks/task-completed.ts (built to dist/).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const ENTRY = path.join(ROOT, 'dist', 'hooks', 'task-completed.js');

if (!fs.existsSync(ENTRY)) {
  console.error(`hugin: hook build output missing (${path.relative(ROOT, ENTRY)}). Run 'npm run build'.`);
  process.exit(1);
}

process.env.HUGIN_ROOT = ROOT;
await import(pathToFileURL(ENTRY).href);
