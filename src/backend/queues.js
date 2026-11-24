import { Queue } from '@forge/events';

// Queues are created once per module, as recommended for @forge/events 2.x.
export const scanQueue = new Queue({ key: 'coam-scan' });
export const execQueue = new Queue({ key: 'coam-exec' });
export const migrateQueue = new Queue({ key: 'coam-migrate' });

/** Time budget for one consumer invocation (function timeout is 900 s). */
// Leaves 5 minutes for a slow last step (API back-off, retries) before the
// 900 s function limit; a timed-out invocation is retried by Forge from the
// last saved position.
export const WORK_BUDGET_MS = 10 * 60 * 1000;
