// Shared state for the @forge stubs. Tests set handlers on it.
const g = globalThis;
g.__forge = g.__forge || {
  kv: new Map(),
  pushed: [],
  sqlLog: [],
  confluenceLog: [],
  confluence: async () => ({ status: 404, body: { message: 'not stubbed' } }),
  sql: async () => ({ rows: [] }),
};
export default g.__forge;
