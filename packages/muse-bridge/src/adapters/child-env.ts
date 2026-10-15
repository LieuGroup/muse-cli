/**
 * Environment for child processes. Children run work the remote agent asked
 * for and their output goes back to it, so they must never inherit the
 * bridge's secrets (MUSE_COOKIE, API tokens…). Only a small allowlist of
 * harmless variables is passed through, plus what config adds explicitly.
 */

const PASS_THROUGH = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TERM",
  "TZ",
];

export function childEnv(
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASS_THROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}
