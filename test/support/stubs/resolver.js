export default class Resolver {
  constructor() { this.defs = {}; }
  define(name, fn) { this.defs[name] = fn; return this; }
  getDefinitions() {
    const defs = this.defs;
    const handler = async (req) => defs[req.call.functionKey](req);
    handler.defs = defs;
    return handler;
  }
}
