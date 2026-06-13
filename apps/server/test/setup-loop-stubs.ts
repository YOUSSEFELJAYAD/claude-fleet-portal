/**
 * Test helper — make placeholder module exports writable so a suite can property-reassign stubs.
 *
 * Vite-node defines named exports via { configurable: true, get: fn } (getter-only). Because
 * configurable:true, we can redefine them with a { value, writable: true } descriptor. Once
 * writable, a subsequent `(mod as any).fn = stub` in a test body works normally.
 *
 * Only the PLACEHOLDER modules (Slices 03/05/06) need this treatment — they're the only ones
 * whose exports tests stub via property-reassign rather than vi.mock or class-instance mutation.
 *
 * This is exported as a helper (not a global vitest setupFile) so the descriptor patch applies
 * ONLY to the loops-core suite that calls it — never to every test file in the package. The
 * fire()/hasWork() dynamic `await import('./controlplane.js')` sees the same cached module
 * namespace, so a stub reassigned here is the one the production code resolves.
 */
async function makeExportsWritable(specifier: string): Promise<void> {
  const mod = await import(specifier);
  for (const key of Object.keys(mod)) {
    const desc = Object.getOwnPropertyDescriptor(mod, key);
    // Only patch getter-only configurable properties (vite-node's SSR transform pattern).
    if (desc && desc.configurable && typeof desc.get === 'function' && !desc.set) {
      const currentValue = (mod as any)[key];
      Object.defineProperty(mod, key, {
        value: currentValue,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
  }
}

/** Make the loop placeholder modules' exports writable for the current suite. */
export async function makeLoopStubsWritable(): Promise<void> {
  await Promise.all([
    makeExportsWritable('../src/controlplane.js'),
    makeExportsWritable('../src/manager.js'),
    makeExportsWritable('../src/loopEval.js'),
  ]);
}
