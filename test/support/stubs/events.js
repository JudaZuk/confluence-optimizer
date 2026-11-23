import forge from './state.js';
export class Queue {
  constructor({ key }) { this.key = key; }
  async push(event) {
    const events = Array.isArray(event) ? event : [event];
    for (const e of events) {
      if (!e || typeof e.body !== 'object') throw new Error('Event body must be an object');
      forge.pushed.push({ queue: this.key, ...e });
    }
    return { jobId: `job-${forge.pushed.length}` };
  }
}
