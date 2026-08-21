import { ConfigError } from './config.js';
import { main } from './index.js';

/**
 * The executable. Everything it does is turn a failure into an exit code.
 *
 * `src/index.ts` is importable -- tests build a gateway and never want a process
 * that installs signal handlers or exits -- so the boundary between "a library
 * that wires a gateway" and "a service" is this file, and nothing else.
 *
 * A configuration mistake prints one line and no stack. It is the failure an
 * operator hits most often, always at the first deploy, and a 40-frame trace
 * buries the name of the variable they forgot.
 */
try {
  await main();
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`configuration error: ${err.message}\n`);
    process.exit(78); // EX_CONFIG, so a supervisor can tell this from a crash.
  }
  process.stderr.write(`failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
}
