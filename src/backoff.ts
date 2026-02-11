/**
 * Backoff strategies with jitter to prevent synchronized retry storms.
 * 
 * Based on AWS Architecture Blog recommendations:
 * https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 */

export type JitterStrategy = 'none' | 'full' | 'equal' | 'decorrelated';

/**
 * Calculate the delay for a retry attempt using exponential backoff with jitter.
 * 
 * @param attempt - Current attempt number (0-indexed)
 * @param initialDelayMs - Initial delay in milliseconds
 * @param maxDelayMs - Maximum delay cap in milliseconds
 * @param multiplier - Backoff multiplier (default: 2)
 * @param jitter - Jitter strategy to use
 * @param previousDelay - Previous delay (used for decorrelated jitter)
 * @returns Delay in milliseconds before the next retry
 */
export function calculateBackoff(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  multiplier: number = 2,
  jitter: JitterStrategy = 'full',
  previousDelay?: number
): number {
  // Calculate base exponential backoff
  const exponentialDelay = initialDelayMs * Math.pow(multiplier, attempt);
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  switch (jitter) {
    case 'none':
      // No jitter - deterministic exponential backoff
      // WARNING: Can cause synchronized retry storms
      return cappedDelay;

    case 'full':
      // Full jitter: random value between 0 and cappedDelay
      // Best for reducing collision probability
      return Math.random() * cappedDelay;

    case 'equal':
      // Equal jitter: half deterministic, half random
      // Balances spread with guaranteed minimum delay
      return (cappedDelay / 2) + (Math.random() * cappedDelay / 2);

    case 'decorrelated':
      // Decorrelated jitter: based on previous delay
      // Provides good spread with some correlation to previous attempt
      const prev = previousDelay ?? initialDelayMs;
      const decorrelated = Math.random() * (prev * 3 - initialDelayMs) + initialDelayMs;
      return Math.min(decorrelated, maxDelayMs);

    default:
      return cappedDelay;
  }
}

/**
 * Create a backoff calculator with preset configuration.
 * 
 * @example
 * ```typescript
 * const backoff = createBackoffCalculator({
 *   initialDelayMs: 100,
 *   maxDelayMs: 10000,
 *   multiplier: 2,
 *   jitter: 'full'
 * });
 * 
 * const delay1 = backoff(0); // First retry delay
 * const delay2 = backoff(1); // Second retry delay
 * ```
 */
export function createBackoffCalculator(options: {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier?: number;
  jitter?: JitterStrategy;
}): (attempt: number) => number {
  const { initialDelayMs, maxDelayMs, multiplier = 2, jitter = 'full' } = options;
  let previousDelay = initialDelayMs;

  return (attempt: number): number => {
    const delay = calculateBackoff(
      attempt,
      initialDelayMs,
      maxDelayMs,
      multiplier,
      jitter,
      previousDelay
    );
    previousDelay = delay;
    return delay;
  };
}

/**
 * Sleep for a specified duration.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
