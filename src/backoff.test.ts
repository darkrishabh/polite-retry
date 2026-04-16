import {
  calculateBackoff,
  createBackoffCalculator,
  sleep,
} from './backoff';

describe('calculateBackoff', () => {
  it('should calculate exponential backoff without jitter', () => {
    expect(calculateBackoff(0, 100, 10000, 2, 'none')).toBe(100);
    expect(calculateBackoff(1, 100, 10000, 2, 'none')).toBe(200);
    expect(calculateBackoff(2, 100, 10000, 2, 'none')).toBe(400);
  });

  it('should cap at maxDelayMs', () => {
    expect(calculateBackoff(10, 100, 1000, 2, 'none')).toBe(1000);
  });

  it('should apply full jitter', () => {
    const delays = Array.from({ length: 100 }, () =>
      calculateBackoff(1, 100, 10000, 2, 'full'),
    );
    expect(delays.every((d) => d >= 0 && d <= 200)).toBe(true);
    expect(new Set(delays).size).toBeGreaterThan(1);
  });

  it('should apply equal jitter', () => {
    const delays = Array.from({ length: 100 }, () =>
      calculateBackoff(1, 100, 10000, 2, 'equal'),
    );
    expect(delays.every((d) => d >= 100 && d <= 200)).toBe(true);
  });

  it('should apply decorrelated jitter within bounds', () => {
    const delays = Array.from({ length: 50 }, () =>
      calculateBackoff(2, 50, 5000, 2, 'decorrelated', 200),
    );
    expect(delays.every((d) => d >= 0 && d <= 5000)).toBe(true);
  });
});

describe('createBackoffCalculator', () => {
  it('should return increasing delays for none jitter', () => {
    const next = createBackoffCalculator({
      initialDelayMs: 10,
      maxDelayMs: 1000,
      multiplier: 2,
      jitter: 'none',
    });
    expect(next(0)).toBe(10);
    expect(next(1)).toBe(20);
    expect(next(2)).toBe(40);
  });

  it('should carry previous delay for decorrelated jitter', () => {
    const next = createBackoffCalculator({
      initialDelayMs: 100,
      maxDelayMs: 10000,
      multiplier: 2,
      jitter: 'decorrelated',
    });
    const d0 = next(0);
    const d1 = next(1);
    expect(d0).toBeGreaterThanOrEqual(0);
    expect(d1).toBeGreaterThanOrEqual(0);
  });
});

describe('sleep', () => {
  it('should resolve after the given delay', async () => {
    jest.useFakeTimers();
    const p = sleep(1000);
    jest.advanceTimersByTime(1000);
    await expect(p).resolves.toBeUndefined();
    jest.useRealTimers();
  });
});
