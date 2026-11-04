#!/usr/bin/env node
import { createConsoleServer, DEFAULT_ROOT } from '../lib/console.js';

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * A value after `--port` or `--port=` is required. Falling back to the env
 * default when the flag is bare (last, or followed by another flag) would bind
 * a port the caller never asked for.
 */
function portValue(): string | undefined {
  const inline = args.find((arg) => arg.startsWith('--port='));
  if (inline !== undefined) {
    const value = inline.slice('--port='.length);
    if (!value) {
      console.error('hugin console: --port requires a value');
      process.exit(2);
    }
    return value;
  }
  const index = args.indexOf('--port');
  if (index === -1) return undefined;
  const next = args[index + 1];
  if (!next || next.startsWith('--')) {
    console.error('hugin console: --port requires a value');
    process.exit(2);
  }
  return next;
}

const port = Number(portValue() ?? process.env.HUGIN_CONSOLE_PORT ?? 8787);
const host = flag('--host') ?? '127.0.0.1';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('hugin console: --port must be an integer between 1 and 65535');
  process.exit(2);
}

if (host !== '127.0.0.1' && host !== 'localhost') {
  console.error('hugin console: refusing to bind a non-loopback host');
  process.exit(2);
}

const server = createConsoleServer({ root: DEFAULT_ROOT, host, port });

server.on('error', (error) => {
  const failure = error as NodeJS.ErrnoException;
  if (failure?.code === 'EADDRINUSE') {
    console.error(`hugin console: port ${port} is already in use`);
  } else {
    console.error(`hugin console: ${failure?.message ?? failure}`);
  }
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`Hugin console: http://${host}:${port}`);
  console.log('Read-only view over .hugin/runs/, .hugin/memory/, and claude agents.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
