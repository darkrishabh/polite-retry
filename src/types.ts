/**
 * Retry configuration options
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;

  /** Initial delay in milliseconds before first retry (default: 100) */
  initialDelayMs?: number;

  /** Maximum delay in milliseconds between retries (default: 30000) */
  maxDelayMs?: number;

  /** Backoff multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;

  /** Jitter strategy to prevent synchronized retries (default: 'full') */
  jitter?: 'none' | 'full' | 'equal' | 'decorrelated';

  /** Predicate to determine if an error should trigger a retry */
  retryIf?: (error: Error) => boolean;

  /** Callback invoked before each retry attempt */
  onRetry?: (error: Error, attempt: number, delayMs: number) => void;

  /** Timeout for each attempt in milliseconds (optional) */
  timeoutMs?: number;
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerOptions {
  /** Failure threshold to open the circuit (default: 0.5 = 50%) */
  failureThreshold?: number;

  /** Number of requests to consider for failure rate calculation (default: 10) */
  windowSize?: number;

  /** Time in milliseconds to wait before attempting to close the circuit (default: 30000) */
  resetTimeoutMs?: number;

  /** Callback when circuit state changes */
  onStateChange?: (state: CircuitState) => void;
}

/**
 * Adaptive Retry Budgeting (ARB) configuration
 */
export interface AdaptiveRetryOptions extends RetryOptions {
  /** Initial retry budget as fraction of base load (default: 0.2 = 20%) */
  initialBudget?: number;

  /** Budget increase rate when failure rate is low (default: 0.1) */
  budgetIncreaseRate?: number;

  /** Budget decrease rate when failure rate is high (default: 0.5) */
  budgetDecreaseRate?: number;

  /** High failure threshold to decrease budget (default: 0.3) */
  highFailureThreshold?: number;

  /** Low failure threshold to increase budget (default: 0.05) */
  lowFailureThreshold?: number;

  /** Budget adjustment interval in milliseconds (default: 1000) */
  adjustmentIntervalMs?: number;

  /** Callback when budget changes */
  onBudgetChange?: (budget: number, failureRate: number) => void;

  /** Check for backpressure signal from downstream */
  checkBackpressure?: () => boolean | Promise<boolean>;
}

/**
 * Circuit breaker states
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Result of a retry operation
 */
export interface RetryResult<T> {
  /** The successful result, if any */
  result?: T;

  /** The final error, if all retries failed */
  error?: Error;

  /** Whether the operation succeeded */
  success: boolean;

  /** Total number of attempts made */
  attempts: number;

  /** Total time spent including delays */
  totalTimeMs: number;
}

/**
 * Metrics collected during retry operations
 */
export interface RetryMetrics {
  /** Total number of requests */
  totalRequests: number;

  /** Number of successful requests */
  successfulRequests: number;

  /** Number of failed requests (after all retries) */
  failedRequests: number;

  /** Total number of retry attempts */
  totalRetries: number;

  /** Current failure rate (exponential moving average) */
  failureRate: number;

  /** Current retry amplification factor */
  retryAmplificationFactor: number;
}
