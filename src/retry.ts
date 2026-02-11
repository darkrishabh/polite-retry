import { RetryOptions, RetryResult, AdaptiveRetryOptions } from './types';
import { calculateBackoff, sleep, JitterStrategy } from './backoff';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';
import { AdaptiveRetryBudget } from './adaptive-budget';

/**
 * Default retry predicate - retry on any error.
 */
const defaultRetryIf = (_error: Error): boolean => true;

/**
 * Retry a function with exponential backoff and jitter.
 * 
 * @example
 * ```typescript
 * const result = await retry(
 *   async () => {
 *     const response = await fetch('https://api.example.com/data');
 *     if (!response.ok) throw new Error(`HTTP ${response.status}`);
 *     return response.json();
 *   },
 *   {
 *     maxRetries: 3,
 *     initialDelayMs: 100,
 *     jitter: 'full',
 *     onRetry: (err, attempt) => console.log(`Retry ${attempt}: ${err.message}`)
 *   }
 * );
 * ```
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelayMs = 100,
    maxDelayMs = 30000,
    backoffMultiplier = 2,
    jitter = 'full',
    retryIf = defaultRetryIf,
    onRetry,
    timeoutMs,
  } = options;

  let lastError: Error | undefined;
  let previousDelay = initialDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Execute with optional timeout
      if (timeoutMs) {
        return await withTimeout(fn(), timeoutMs);
      }
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry
      if (attempt >= maxRetries || !retryIf(lastError)) {
        throw lastError;
      }

      // Calculate backoff delay
      const delay = calculateBackoff(
        attempt,
        initialDelayMs,
        maxDelayMs,
        backoffMultiplier,
        jitter as JitterStrategy,
        previousDelay
      );
      previousDelay = delay;

      // Notify before retry
      onRetry?.(lastError, attempt + 1, delay);

      // Wait before retry
      await sleep(delay);
    }
  }

  throw lastError ?? new Error('Retry failed');
}

/**
 * Retry with detailed result information.
 */
export async function retryWithResult<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<RetryResult<T>> {
  const startTime = Date.now();
  let attempts = 0;

  try {
    const wrappedFn = async () => {
      attempts++;
      return await fn();
    };

    // Create modified options that track attempts
    const modifiedOptions = {
      ...options,
      onRetry: (error: Error, attempt: number, delayMs: number) => {
        options.onRetry?.(error, attempt, delayMs);
      },
    };

    const result = await retry(wrappedFn, modifiedOptions);
    
    return {
      result,
      success: true,
      attempts,
      totalTimeMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
      success: false,
      attempts,
      totalTimeMs: Date.now() - startTime,
    };
  }
}

/**
 * Retry with circuit breaker protection.
 * 
 * @example
 * ```typescript
 * const breaker = new CircuitBreaker({ failureThreshold: 0.5 });
 * 
 * const result = await retryWithCircuitBreaker(
 *   async () => fetchFromService(),
 *   breaker,
 *   { maxRetries: 3 }
 * );
 * ```
 */
export async function retryWithCircuitBreaker<T>(
  fn: () => Promise<T>,
  circuitBreaker: CircuitBreaker,
  options: RetryOptions = {}
): Promise<T> {
  const { retryIf = defaultRetryIf, ...restOptions } = options;

  // Check circuit before attempting
  if (!circuitBreaker.isAllowed()) {
    throw new CircuitOpenError();
  }

  try {
    const result = await retry(fn, {
      ...restOptions,
      retryIf: (error) => {
        // Record failure for circuit breaker
        circuitBreaker.recordFailure();
        
        // Check if circuit is still allowing requests
        if (!circuitBreaker.isAllowed()) {
          return false;
        }
        
        return retryIf(error);
      },
    });

    circuitBreaker.recordSuccess();
    return result;
  } catch (error) {
    circuitBreaker.recordFailure();
    throw error;
  }
}

/**
 * Retry with Adaptive Retry Budgeting (ARB).
 * 
 * This is the recommended approach for distributed systems as it
 * prevents retry amplification during failures.
 * 
 * @example
 * ```typescript
 * const budget = new AdaptiveRetryBudget({
 *   initialBudget: 0.2,
 *   onBudgetChange: (budget, rate) => {
 *     console.log(`Budget: ${budget}, Failure rate: ${rate}`);
 *   }
 * });
 * 
 * const result = await retryWithBudget(
 *   async () => fetchFromService(),
 *   budget,
 *   { maxRetries: 3 }
 * );
 * 
 * // Clean up when done
 * budget.dispose();
 * ```
 */
export async function retryWithBudget<T>(
  fn: () => Promise<T>,
  budgetManager: AdaptiveRetryBudget,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelayMs = 100,
    maxDelayMs = 30000,
    backoffMultiplier = 2,
    jitter = 'full',
    retryIf = defaultRetryIf,
    onRetry,
    timeoutMs,
  } = options;

  let lastError: Error | undefined;
  let previousDelay = initialDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = timeoutMs 
        ? await withTimeout(fn(), timeoutMs)
        : await fn();
      
      budgetManager.recordOutcome(true);
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      budgetManager.recordOutcome(false);

      // Check if we should retry
      if (attempt >= maxRetries || !retryIf(lastError)) {
        throw lastError;
      }

      // Check budget allows retry
      const shouldRetry = await budgetManager.shouldRetry();
      if (!shouldRetry) {
        throw lastError;
      }

      // Calculate backoff delay
      const delay = calculateBackoff(
        attempt,
        initialDelayMs,
        maxDelayMs,
        backoffMultiplier,
        jitter as JitterStrategy,
        previousDelay
      );
      previousDelay = delay;

      onRetry?.(lastError, attempt + 1, delay);
      await sleep(delay);
    }
  }

  throw lastError ?? new Error('Retry failed');
}

/**
 * Retry with both Circuit Breaker AND Adaptive Retry Budgeting.
 * 
 * This combines both protection mechanisms:
 * - Circuit Breaker: Stops ALL requests when service is down (binary on/off)
 * - ARB: Limits retry volume to prevent amplification (gradual control)
 * 
 * @example
 * ```typescript
 * const breaker = new CircuitBreaker({ failureThreshold: 0.5 });
 * const budget = new AdaptiveRetryBudget({ initialBudget: 0.2 });
 * 
 * const result = await retryWithProtection(
 *   async () => fetch('https://api.example.com/data'),
 *   { circuitBreaker: breaker, budget },
 *   { maxRetries: 3, jitter: 'full' }
 * );
 * ```
 */
export async function retryWithProtection<T>(
  fn: () => Promise<T>,
  protection: {
    circuitBreaker: CircuitBreaker;
    budget: AdaptiveRetryBudget;
  },
  options: RetryOptions = {}
): Promise<T> {
  const { circuitBreaker, budget } = protection;
  const {
    maxRetries = 3,
    initialDelayMs = 100,
    maxDelayMs = 30000,
    backoffMultiplier = 2,
    jitter = 'full',
    retryIf = defaultRetryIf,
    onRetry,
    timeoutMs,
  } = options;

  // Check circuit breaker first - if open, fail immediately
  if (!circuitBreaker.isAllowed()) {
    throw new CircuitOpenError();
  }

  let lastError: Error | undefined;
  let previousDelay = initialDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = timeoutMs
        ? await withTimeout(fn(), timeoutMs)
        : await fn();

      // Success - record it
      circuitBreaker.recordSuccess();
      budget.recordOutcome(true);
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Record failure
      circuitBreaker.recordFailure();
      budget.recordOutcome(false);

      // Check if we should retry
      if (attempt >= maxRetries || !retryIf(lastError)) {
        throw lastError;
      }

      // Check circuit breaker - might have opened due to this failure
      if (!circuitBreaker.isAllowed()) {
        throw new CircuitOpenError('Circuit opened during retry sequence');
      }

      // Check budget allows retry
      const shouldRetry = await budget.shouldRetry();
      if (!shouldRetry) {
        throw lastError;
      }

      // Calculate backoff delay
      const delay = calculateBackoff(
        attempt,
        initialDelayMs,
        maxDelayMs,
        backoffMultiplier,
        jitter as JitterStrategy,
        previousDelay
      );
      previousDelay = delay;

      onRetry?.(lastError, attempt + 1, delay);
      await sleep(delay);
    }
  }

  throw lastError ?? new Error('Retry failed');
}

/**
 * Create a retryable version of a function.
 * 
 * @example
 * ```typescript
 * const fetchData = createRetryable(
 *   async (id: string) => {
 *     const response = await fetch(`/api/data/${id}`);
 *     return response.json();
 *   },
 *   { maxRetries: 3, jitter: 'full' }
 * );
 * 
 * // Use like a normal function
 * const data = await fetchData('123');
 * ```
 */
export function createRetryable<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: RetryOptions = {}
): (...args: TArgs) => Promise<TResult> {
  return (...args: TArgs) => retry(() => fn(...args), options);
}

/**
 * Wrap a promise with a timeout.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}
