/**
 * One place decides which Claude executable to run. The terminal CLI and the
 * web console both shell out to `claude agents`, and they must agree: an env
 * override or the Windows `claude.exe` name applies to both.
 *
 * `HUGIN_CLAUDE` wins (tests, non-standard installs, shims); otherwise the
 * platform default. The env/platform arguments are injectable so the rule is
 * testable without touching the real process.
 */
export function claudeBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = typeof env.HUGIN_CLAUDE === 'string' ? env.HUGIN_CLAUDE.trim() : '';
  if (override) return override;
  return platform === 'win32' ? 'claude.exe' : 'claude';
}
