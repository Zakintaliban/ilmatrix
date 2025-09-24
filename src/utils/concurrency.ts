/**
 * A simple implementation of p-limit style concurrency limiter
 * Used consistently across the application for managing concurrent operations
 */
export interface Limiter {
  <T>(fn: () => Promise<T>): Promise<T>;
  readonly concurrency: number;
  readonly pending: number;
  readonly active: number;
}

export function createLimiter(concurrency: number): Limiter {
  if (concurrency < 1) {
    throw new Error("Concurrency must be at least 1");
  }

  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= concurrency || queue.length === 0) {
      return;
    }

    const job = queue.shift();
    if (job) {
      active++;
      job();
    }
  };

  const limit = <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        fn()
          .then(resolve)
          .catch(reject)
          .finally(() => {
            active--;
            next();
          });
      };

      queue.push(run);
      next();
    });
  };

  // Add readonly properties for monitoring
  Object.defineProperty(limit, "concurrency", {
    get: () => concurrency,
    enumerable: true,
  });

  Object.defineProperty(limit, "pending", {
    get: () => queue.length,
    enumerable: true,
  });

  Object.defineProperty(limit, "active", {
    get: () => active,
    enumerable: true,
  });

  return limit as Limiter;
}

/**
 * Creates a timeout wrapper for promises
 */
export function withTimeout<T>(
  promiseFactory: () => Promise<T>,
  timeoutMs: number,
  errorMessage = "Operation timed out"
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${errorMessage} (${timeoutMs}ms)`));
    }, timeoutMs);

    promiseFactory()
      .then(resolve)
      .catch(reject)
      .finally(() => clearTimeout(timer));
  });
}
