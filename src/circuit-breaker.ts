import { CircuitBreakerOptions, CircuitState } from './types';

/**
 * Circuit Breaker implementation to prevent cascading failures.
 * 
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Failure threshold exceeded, requests are rejected immediately
 * - HALF-OPEN: Testing if service has recovered
 * 
 * Based on the pattern described by Michael Nygard in "Release It!"
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures: boolean[] = [];
  private lastFailureTime: number = 0;
  private halfOpenAttempts: number = 0;

  private readonly failureThreshold: number;
  private readonly windowSize: number;
  private readonly resetTimeoutMs: number;
  private readonly onStateChange?: (state: CircuitState) => void;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 0.5;
    this.windowSize = options.windowSize ?? 10;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30000;
    this.onStateChange = options.onStateChange;
  }

  /**
   * Get the current circuit state.
   */
  getState(): CircuitState {
    // Check if we should transition from open to half-open
    if (this.state === 'open') {
      const timeSinceFailure = Date.now() - this.lastFailureTime;
      if (timeSinceFailure >= this.resetTimeoutMs) {
        this.transition('half-open');
      }
    }
    return this.state;
  }

  /**
   * Check if the circuit allows requests to pass through.
   */
  isAllowed(): boolean {
    const currentState = this.getState();
    
    if (currentState === 'closed') {
      return true;
    }
    
    if (currentState === 'half-open') {
      // Allow limited requests in half-open state
      this.halfOpenAttempts++;
      return this.halfOpenAttempts <= 1;
    }
    
    // Circuit is open
    return false;
  }

  /**
   * Record a successful request.
   */
  recordSuccess(): void {
    this.failures.push(false);
    this.trimWindow();

    if (this.state === 'half-open') {
      // Success in half-open state closes the circuit
      this.transition('closed');
      this.failures = [];
    }
  }

  /**
   * Record a failed request.
   */
  recordFailure(): void {
    this.failures.push(true);
    this.trimWindow();
    this.lastFailureTime = Date.now();

    if (this.state === 'half-open') {
      // Failure in half-open state reopens the circuit
      this.transition('open');
      return;
    }

    // Check if we should open the circuit
    if (this.state === 'closed' && this.failures.length >= this.windowSize) {
      const failureRate = this.getFailureRate();
      if (failureRate >= this.failureThreshold) {
        this.transition('open');
      }
    }
  }

  /**
   * Get the current failure rate within the sliding window.
   */
  getFailureRate(): number {
    if (this.failures.length === 0) return 0;
    const failureCount = this.failures.filter(f => f).length;
    return failureCount / this.failures.length;
  }

  /**
   * Reset the circuit breaker to closed state.
   */
  reset(): void {
    this.failures = [];
    this.halfOpenAttempts = 0;
    this.transition('closed');
  }

  private transition(newState: CircuitState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.halfOpenAttempts = 0;
      this.onStateChange?.(newState);
    }
  }

  private trimWindow(): void {
    while (this.failures.length > this.windowSize) {
      this.failures.shift();
    }
  }
}

/**
 * Error thrown when circuit breaker is open.
 */
export class CircuitOpenError extends Error {
  constructor(message: string = 'Circuit breaker is open') {
    super(message);
    this.name = 'CircuitOpenError';
  }
}
