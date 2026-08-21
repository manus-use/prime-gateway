import type { Driver } from './types.js';

/**
 * Driver lookup by id.
 *
 * A registry rather than a `switch`, for the same reason the command table is a
 * registry: a `switch` scattered across the core means adding a driver requires
 * finding every site that branches on driver kind, and the one you miss is the
 * one that silently takes the wrong branch.
 *
 * `structured-cli` is declared here but deliberately unimplemented -- see
 * `KNOWN_DRIVERS`.
 */

const drivers = new Map<string, () => Driver>();

export function registerDriver(id: string, factory: () => Driver): void {
  if (drivers.has(id)) throw new Error(`driver ${id} is already registered`);
  drivers.set(id, factory);
}

/**
 * Driver ids this gateway knows about, whether or not they are implemented.
 *
 * The unimplemented entry is listed on purpose. A config naming `structured-cli`
 * should fail with "known but not implemented" rather than "unknown driver" --
 * the two mean different things to whoever wrote the config, and conflating them
 * sends them looking for a typo that isn't there.
 */
export const KNOWN_DRIVERS = ['acp', 'structured-cli'] as const;
export type KnownDriver = (typeof KNOWN_DRIVERS)[number];

export function getDriver(id: string): Driver {
  const factory = drivers.get(id);
  if (factory !== undefined) return factory();

  if ((KNOWN_DRIVERS as readonly string[]).includes(id)) {
    throw new Error(`driver "${id}" is known but not implemented in this build`);
  }
  throw new Error(
    `unknown driver "${id}"; registered: ${[...drivers.keys()].join(', ') || '(none)'}`,
  );
}

export function registeredDrivers(): string[] {
  return [...drivers.keys()];
}

/** Test-only. Registration is process-global, so tests must be able to reset it. */
export function resetDrivers(): void {
  drivers.clear();
}
