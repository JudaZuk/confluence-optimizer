// Module resolution hook used only by the smoke test: maps @forge/* packages to
// small in-memory stand-ins so the backend can be exercised without Atlassian.
const STUBS = ['api', 'sql', 'kvs', 'events', 'resolver'];

export async function resolve(specifier, context, nextResolve) {
  const m = /^@forge\/([a-z]+)$/.exec(specifier);
  if (m && STUBS.includes(m[1])) {
    return { url: new URL(`./stubs/${m[1]}.js`, import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
