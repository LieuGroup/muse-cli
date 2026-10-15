#!/usr/bin/env node
import { serve } from "./server.js";
import { MuseConnection } from "./tools.js";

await serve({
  input: process.stdin,
  output: process.stdout,
  connection: new MuseConnection(),
  log: (line) => process.stderr.write(`${line}\n`),
});
