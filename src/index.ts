/**
 * Polite Retry - Retries that don't overwhelm your servers
 * 
 * Implements strategies from "Retry Amplification in Distributed Systems"
 * to prevent cascading failures caused by naive retry policies.
 * 
 * @packageDocumentation
 */

// Core retry functions
export { 
  retry, 
  retryWithResult,
  retryWithCircuitBreaker, 
  retryWithBudget,
  retryWithProtection,
  createRetryable,
} from './retry';

// Backoff utilities
export { 
  calculateBackoff, 
  createBackoffCalculator,
  sleep,
  type JitterStrategy,
} from './backoff';

// Circuit breaker
export { 
  CircuitBreaker, 
  CircuitOpenError,
} from './circuit-breaker';

// Adaptive Retry Budgeting
export { 
  AdaptiveRetryBudget,
} from './adaptive-budget';

// Backpressure signaling
export {
  BackpressureManager,
  RequestCounter,
  createBackpressureMiddleware,
  createLoadLevelCalculator,
  BACKPRESSURE_HEADERS,
  type BackpressureSignal,
} from './backpressure';

// Types
export type {
  RetryOptions,
  RetryResult,
  RetryMetrics,
  CircuitBreakerOptions,
  CircuitState,
  AdaptiveRetryOptions,
} from './types';
