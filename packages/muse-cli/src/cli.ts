#!/usr/bin/env node
import { run } from "./main.js";

const code = await run(process.argv.slice(2), {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  write: (text) => process.stdout.write(text),
});
process.exitCode = code;
// The gateway socket may keep the event loop alive briefly; exit promptly.
setImmediate(() => process.exit(code));
