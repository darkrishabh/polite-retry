import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  BackpressureManager,
  BACKPRESSURE_HEADERS,
  createBackpressureMiddleware,
  createLoadLevelCalculator,
  RequestCounter,
} from './backpressure';

function mockResponse(): ServerResponse {
  const store: Record<string, string> = {};
  return {
    setHeader: jest.fn((name: string, value: string | number) => {
      store[name] = String(value);
    }),
    on: jest.fn(),
  } as unknown as ServerResponse;
}

describe('BackpressureManager', () => {
  it('records load from plain object headers', () => {
    const bm = new BackpressureManager({ overloadThreshold: 0.7 });
    bm.recordFromHeaders('svc', {
      [BACKPRESSURE_HEADERS.LOAD_LEVEL]: '0.85',
    });
    expect(bm.isOverloaded('svc')).toBe(true);
    expect(bm.getLoadLevel('svc')).toBe(0.85);
  });

  it('records from Web Headers', () => {
    const bm = new BackpressureManager({ overloadThreshold: 0.9 });
    const headers = new Headers();
    headers.set(BACKPRESSURE_HEADERS.LOAD_LEVEL, '0.3');
    bm.recordFromHeaders('api', headers);
    expect(bm.isOverloaded('api')).toBe(false);
    expect(bm.getLoadLevel('api')).toBe(0.3);
  });

  it('treats load shedding as overloaded', () => {
    const bm = new BackpressureManager();
    bm.recordFromHeaders('x', {
      [BACKPRESSURE_HEADERS.SHEDDING]: 'true',
    });
    expect(bm.isOverloaded('x')).toBe(true);
  });

  it('expires signals after TTL', () => {
    jest.useFakeTimers();
    const bm = new BackpressureManager({ signalTtlMs: 500 });
    bm.recordSignal('svc', { isOverloaded: true });
    expect(bm.getSignal('svc')).toBeDefined();
    jest.advanceTimersByTime(501);
    expect(bm.getSignal('svc')).toBeUndefined();
    jest.useRealTimers();
  });

  it('clear removes all signals', () => {
    const bm = new BackpressureManager();
    bm.recordSignal('a', { isOverloaded: false });
    bm.clear();
    expect(bm.getSignal('a')).toBeUndefined();
  });
});

describe('createBackpressureMiddleware', () => {
  it('sets load header and calls next', async () => {
    const res = mockResponse();
    const next = jest.fn();
    const mw = createBackpressureMiddleware({
      getLoadLevel: () => 0.42,
    });
    await mw({} as IncomingMessage, res, next);
    expect(res.setHeader).toHaveBeenCalledWith(
      BACKPRESSURE_HEADERS.LOAD_LEVEL,
      '0.42',
    );
    expect(next).toHaveBeenCalled();
  });

  it('adds shedding headers when over threshold', async () => {
    const res = mockResponse();
    const next = jest.fn();
    const mw = createBackpressureMiddleware({
      getLoadLevel: () => 0.95,
      overloadThreshold: 0.8,
      retryAfterSeconds: 7,
    });
    await mw({} as IncomingMessage, res, next);
    expect(res.setHeader).toHaveBeenCalledWith(
      BACKPRESSURE_HEADERS.SHEDDING,
      'true',
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      BACKPRESSURE_HEADERS.RETRY_AFTER,
      '7',
    );
  });
});

describe('RequestCounter', () => {
  it('tracks concurrent requests via middleware', () => {
    const counter = new RequestCounter();
    const next = jest.fn();
    let finishHandler: (() => void) | undefined;
    const res = {
      on: jest.fn((event: string, cb: () => void) => {
        if (event === 'finish') finishHandler = cb;
      }),
    } as unknown as ServerResponse;

    counter.middleware()({} as IncomingMessage, res, next);
    expect(counter.getCount()).toBe(1);
    expect(counter.getMaxObserved()).toBe(1);

    finishHandler?.();
    expect(counter.getCount()).toBe(0);
  });

  it('reset clears counts', () => {
    const counter = new RequestCounter();
    counter.increment();
    counter.increment();
    counter.reset();
    expect(counter.getCount()).toBe(0);
    expect(counter.getMaxObserved()).toBe(0);
  });
});

describe('createLoadLevelCalculator', () => {
  it('computes request-based load', () => {
    const calc = createLoadLevelCalculator({
      maxConcurrentRequests: 20,
      getCurrentRequests: () => 10,
    });
    expect(calc()).toBe(0.5);
  });

  it('returns max of multiple indicators', () => {
    const calc = createLoadLevelCalculator({
      maxConcurrentRequests: 10,
      getCurrentRequests: () => 5,
      maxCpuPercent: 100,
      getCpuPercent: () => 90,
    });
    expect(calc()).toBe(0.9);
  });

  it('returns 0 when no indicators configured', () => {
    const calc = createLoadLevelCalculator({});
    expect(calc()).toBe(0);
  });
});
