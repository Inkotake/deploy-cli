#!/usr/bin/env node
/** Entry point. All logic lives in ../src/cli.mjs so the CLI stays importable for tests. */
import { run } from '../src/cli.mjs';

run().then((code) => {
  process.exitCode = code;
});
