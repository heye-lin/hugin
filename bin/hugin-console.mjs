#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENTRY = path.join(ROOT, 'dist', 'cli', 'console-main.js');

if (!fs.existsSync(ENTRY)) {
  console.error(`hugin console: build output missing (${path.relative(ROOT, ENTRY)}). Run 'npm run build' first.`);
  process.exit(1);
}

process.env.HUGIN_ROOT = ROOT;
process.chdir(ROOT);
await import(pathToFileURL(ENTRY).href);
