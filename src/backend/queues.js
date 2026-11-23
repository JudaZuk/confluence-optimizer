import { Queue } from '@forge/events';

// Queues are created once per module, as recommended for @forge/events 2.x.
export const scanQueue = new Queue({ key: 'coam-scan' });
export const execQueue = new Queue({ key: 'coam-exec' });
export const migrateQueue = new Queue({ key: 'coam-migrate' });

/** Time budget for one consumer invocation (function timeout is 900 s). */
export const WORK_BUDGET_MS = 12 * 60 * 1000;
