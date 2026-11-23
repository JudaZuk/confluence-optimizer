import forge from './state.js';

export const sql = {
  prepare(query) {
    let params = [];
    return {
      bindParams(...p) { params = p; return this; },
      async execute() {
        const placeholders = (query.match(/\?/g) || []).length;
        if (placeholders !== params.length) {
          throw new Error(`placeholder mismatch: ${placeholders} vs ${params.length} in ${query.slice(0, 120)}`);
        }
        forge.sqlLog.push({ query, params });
        return forge.sql(query, params);
      },
    };
  },
  async executeRaw(query) { return this.prepare(query).execute(); },
};

export const migrationRunner = {
  queued: [],
  enqueue(name, ddl) { this.queued.push(name); return this; },
  async run() { return this.queued.splice(0); },
};

export const errorCodes = {};
export default sql;
