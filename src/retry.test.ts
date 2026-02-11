import { retry, retryWithResult, retryWithBudget, createRetryable } from './retry';
import { AdaptiveRetryBudget } from './adaptive-budget';
import { CircuitBreaker } from './circuit-breaker';
import { calculateBackoff } from './backoff';

describe('retry', () => {
  it('should succeed on first attempt', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    
    const result = await retry(fn);
    
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure and eventually succeed', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('success');
    
    const result = await retry(fn, { 
      maxRetries: 3,
      initialDelayMs: 1,
    });
    
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should throw after max retries exceeded', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('always fails'));
    
    await expect(retry(fn, { 
      maxRetries: 2,
      initialDelayMs: 1,
    })).rejects.toThrow('always fails');
    
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('should call onRetry callback', async () => {
    const onRetry = jest.fn();
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('success');
    
    await retry(fn, { 
      maxRetries: 1,
      initialDelayMs: 1,
      onRetry,
    });
    
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.any(Error),
      1,
      expect.any(Number)
    );
  });

  it('should respect retryIf predicate', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('no retry'));
    
    await expect(retry(fn, { 
      maxRetries: 3,
      initialDelayMs: 1,
      retryIf: () => false,
    })).rejects.toThrow('no retry');
    
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('retryWithResult', () => {
  it('should return success result with metadata', async () => {
    const fn = jest.fn().mockResolvedValue('data');
    
    const result = await retryWithResult(fn);
    
    expect(result.success).toBe(true);
    expect(result.result).toBe('data');
    expect(result.attempts).toBe(1);
    expect(result.totalTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('should return failure result with metadata', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('failed'));
    
    const result = await retryWithResult(fn, { 
      maxRetries: 1,
      initialDelayMs: 1,
    });
    
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('failed');
    expect(result.attempts).toBe(2);
  });
});

describe('calculateBackoff', () => {
  it('should calculate exponential backoff without jitter', () => {
    const delay0 = calculateBackoff(0, 100, 10000, 2, 'none');
    const delay1 = calculateBackoff(1, 100, 10000, 2, 'none');
    const delay2 = calculateBackoff(2, 100, 10000, 2, 'none');
    
    expect(delay0).toBe(100);
    expect(delay1).toBe(200);
    expect(delay2).toBe(400);
  });

  it('should cap at maxDelayMs', () => {
    const delay = calculateBackoff(10, 100, 1000, 2, 'none');
    expect(delay).toBe(1000);
  });

  it('should apply full jitter', () => {
    const delays = Array.from({ length: 100 }, () => 
      calculateBackoff(1, 100, 10000, 2, 'full')
    );
    
    // All delays should be between 0 and 200
    expect(delays.every(d => d >= 0 && d <= 200)).toBe(true);
    
    // Should have variation (not all same value)
    const uniqueDelays = new Set(delays);
    expect(uniqueDelays.size).toBeGreaterThan(1);
  });

  it('should apply equal jitter', () => {
    const delays = Array.from({ length: 100 }, () => 
      calculateBackoff(1, 100, 10000, 2, 'equal')
    );
    
    // All delays should be between 100 and 200 (half + random half)
    expect(delays.every(d => d >= 100 && d <= 200)).toBe(true);
  });
});

describe('CircuitBreaker', () => {
  it('should start in closed state', () => {
    const breaker = new CircuitBreaker();
    expect(breaker.getState()).toBe('closed');
    expect(breaker.isAllowed()).toBe(true);
  });

  it('should open after failure threshold', () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 0.5,
      windowSize: 4,
    });
    
    // Record 50% failures (2 of 4)
    breaker.recordSuccess();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    
    expect(breaker.getState()).toBe('open');
    expect(breaker.isAllowed()).toBe(false);
  });

  it('should transition to half-open after timeout', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 0.5,
      windowSize: 2,
      resetTimeoutMs: 10,
    });
    
    breaker.recordFailure();
    breaker.recordFailure();
    
    expect(breaker.getState()).toBe('open');
    
    await new Promise(r => setTimeout(r, 15));
    
    expect(breaker.getState()).toBe('half-open');
  });
});

describe('AdaptiveRetryBudget', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('should allow retries when budget is available', () => {
    const budget = new AdaptiveRetryBudget({ initialBudget: 0.5 });
    
    // Should allow at least some retries
    let allowed = 0;
    for (let i = 0; i < 100; i++) {
      if (budget.shouldRetrySync()) allowed++;
    }
    
    expect(allowed).toBeGreaterThan(0);
    budget.dispose();
  });

  it('should track metrics correctly', () => {
    const budget = new AdaptiveRetryBudget();
    
    budget.recordOutcome(true);
    budget.recordOutcome(true);
    budget.recordOutcome(false);
    
    const metrics = budget.getMetrics();
    expect(metrics.totalRequests).toBe(3);
    expect(metrics.successfulRequests).toBe(2);
    expect(metrics.failedRequests).toBe(1);
    
    budget.dispose();
  });

  it('should decrease budget on high failure rate', async () => {
    jest.useFakeTimers();
    
    const budget = new AdaptiveRetryBudget({
      initialBudget: 0.2,
      highFailureThreshold: 0.3,
      adjustmentIntervalMs: 100,
    });
    
    // Record many failures to push failure rate above threshold
    for (let i = 0; i < 50; i++) {
      budget.recordOutcome(false);
    }
    
    const initialBudget = budget.getBudget();
    
    // Advance timer to trigger adjustment
    jest.advanceTimersByTime(100);
    
    expect(budget.getBudget()).toBeLessThan(initialBudget);
    
    budget.dispose();
  });
});

describe('createRetryable', () => {
  it('should create a retryable function', async () => {
    const originalFn = jest.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('success');
    
    const retryableFn = createRetryable(originalFn, {
      maxRetries: 1,
      initialDelayMs: 1,
    });
    
    const result = await retryableFn();
    
    expect(result).toBe('success');
    expect(originalFn).toHaveBeenCalledTimes(2);
  });

  it('should pass arguments through', async () => {
    const originalFn = jest.fn().mockResolvedValue('result');
    
    const retryableFn = createRetryable(originalFn);
    
    await retryableFn('arg1', 'arg2');
    
    expect(originalFn).toHaveBeenCalledWith('arg1', 'arg2');
  });
});
