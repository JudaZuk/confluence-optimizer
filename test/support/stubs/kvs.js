import forge from './state.js';
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
export const kvs = {
  async get(k) { return clone(forge.kv.get(k)); },
  async set(k, v) { forge.kv.set(k, clone(v)); },
  async delete(k) { forge.kv.delete(k); },
};
