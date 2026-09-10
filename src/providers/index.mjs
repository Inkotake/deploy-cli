/**
 * Registry adapter id -> implementation.
 *
 * `wh-drop` has no implementation on purpose: no host, documentation or API for it could be
 * located, and the registry disables it. A lookup for it returns null so it can never be
 * attempted, even if an overlay wrongly re-enables it.
 */

import * as shipPage from './ship-page.mjs';
import * as shipstatic from './shipstatic.mjs';
import * as aftPage from './aft-page.mjs';
import * as hereNow from './here-now.mjs';
import * as show from './show.mjs';
import * as dropley from './dropley.mjs';
import * as persistent from './persistent.mjs';

export const ADAPTERS = new Map([
  [shipPage.id, shipPage],
  [shipstatic.id, shipstatic],
  [aftPage.id, aftPage],
  [hereNow.id, hereNow],
  [show.id, show],
  [dropley.id, dropley],
  [persistent.id, persistent]
]);

/** Adapter ids that must never be dispatched. */
export const UNIMPLEMENTED_ADAPTERS = new Set(['wh-drop']);

export function getAdapter(provider) {
  if (!provider || typeof provider.adapter !== 'string') return null;
  if (UNIMPLEMENTED_ADAPTERS.has(provider.adapter)) return null;
  const adapter = ADAPTERS.get(provider.adapter);
  if (!adapter || typeof adapter.deploy !== 'function') return null;
  return adapter;
}

export function adapterIds() {
  return [...ADAPTERS.keys()];
}

/**
 * Whether an adapter can actually be dispatched for this provider.
 * `persistent` is a shared adapter id used by four CLI providers, and `wh-drop` deliberately has
 * no implementation at all.
 */
export function adapterAvailability(provider) {
  return getAdapter(provider) !== null;
}
