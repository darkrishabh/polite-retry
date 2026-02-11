/**
 * Backpressure signaling mechanisms for distributed systems.
 * 
 * Backpressure allows downstream services to signal upstream callers
 * that they are overloaded, preventing retry amplification.
 * 
 * Common approaches:
 * 1. HTTP Headers (X-Backpressure, Retry-After)
 * 2. gRPC Metadata
 * 3. Shared state (Redis, etc.)
 */

/**
 * Backpressure signal from a downstream service.
 */
export interface BackpressureSignal {
  /** Whether the service is experiencing backpressure */
  isOverloaded: boolean;
  
  /** Load level from 0.0 (idle) to 1.0 (fully loaded) */
  loadLevel?: number;
  
  /** Suggested retry delay in milliseconds */
  retryAfterMs?: number;
  
  /** Timestamp when the signal was received */
  timestamp: number;
}

/**
 * Standard HTTP headers for backpressure signaling.
 */
export const BACKPRESSURE_HEADERS = {
  /** Custom header indicating load level (0.0 to 1.0) */
  LOAD_LEVEL: 'X-Backpressure',
  
  /** Standard header indicating when to retry (seconds) */
  RETRY_AFTER: 'Retry-After',
  
  /** Custom header indicating service is shedding load */
  SHEDDING: 'X-Load-Shedding',
} as const;

/**
 * Backpressure manager that tracks signals from downstream services.
 * 
 * @example
 * ```typescript
 * const backpressure = new BackpressureManager();
 * 
 * // After each response, extract and record backpressure signal
 * const response = await fetch('/api/data');
 * backpressure.recordFromHeaders('api-service', response.headers);
 * 
 * // Use with AdaptiveRetryBudget
 * const budget = new AdaptiveRetryBudget({
 *   checkBackpressure: () => backpressure.isOverloaded('api-service')
 * });
 * ```
 */
export class BackpressureManager {
  private signals: Map<string, BackpressureSignal> = new Map();
  
  /** How long a backpressure signal remains valid (default: 30s) */
  private readonly signalTtlMs: number;
  
  /** Load level threshold to consider service overloaded (default: 0.8) */
  private readonly overloadThreshold: number;

  constructor(options: {
    signalTtlMs?: number;
    overloadThreshold?: number;
  } = {}) {
    this.signalTtlMs = options.signalTtlMs ?? 30000;
    this.overloadThreshold = options.overloadThreshold ?? 0.8;
  }

  /**
   * Record a backpressure signal from a service.
   */
  recordSignal(serviceId: string, signal: Omit<BackpressureSignal, 'timestamp'>): void {
    this.signals.set(serviceId, {
      ...signal,
      timestamp: Date.now(),
    });
  }

  /**
   * Extract and record backpressure signal from HTTP response headers.
   * 
   * Looks for:
   * - X-Backpressure: 0.0-1.0 (load level)
   * - Retry-After: seconds (standard HTTP header)
   * - X-Load-Shedding: true/false
   */
  recordFromHeaders(serviceId: string, headers: Headers | Record<string, string>): void {
    const get = (name: string): string | null => {
      if (headers instanceof Headers) {
        return headers.get(name);
      }
      return headers[name] ?? headers[name.toLowerCase()] ?? null;
    };

    const loadLevelStr = get(BACKPRESSURE_HEADERS.LOAD_LEVEL);
    const retryAfterStr = get(BACKPRESSURE_HEADERS.RETRY_AFTER);
    const sheddingStr = get(BACKPRESSURE_HEADERS.SHEDDING);

    const loadLevel = loadLevelStr ? parseFloat(loadLevelStr) : undefined;
    const retryAfterMs = retryAfterStr ? parseFloat(retryAfterStr) * 1000 : undefined;
    const isShedding = sheddingStr === 'true' || sheddingStr === '1';

    // Only record if we got meaningful backpressure info
    if (loadLevel !== undefined || retryAfterMs !== undefined || isShedding) {
      this.recordSignal(serviceId, {
        isOverloaded: isShedding || (loadLevel !== undefined && loadLevel >= this.overloadThreshold),
        loadLevel,
        retryAfterMs,
      });
    }
  }

  /**
   * Check if a service is currently signaling backpressure.
   */
  isOverloaded(serviceId: string): boolean {
    const signal = this.getSignal(serviceId);
    if (!signal) return false;
    
    return signal.isOverloaded;
  }

  /**
   * Get the current load level for a service (0.0 to 1.0).
   * Returns undefined if no signal or signal expired.
   */
  getLoadLevel(serviceId: string): number | undefined {
    const signal = this.getSignal(serviceId);
    return signal?.loadLevel;
  }

  /**
   * Get suggested retry delay for a service.
   * Returns undefined if no signal or no retry-after specified.
   */
  getRetryAfterMs(serviceId: string): number | undefined {
    const signal = this.getSignal(serviceId);
    return signal?.retryAfterMs;
  }

  /**
   * Get the current signal for a service, if valid.
   */
  getSignal(serviceId: string): BackpressureSignal | undefined {
    const signal = this.signals.get(serviceId);
    if (!signal) return undefined;

    // Check if signal has expired
    const age = Date.now() - signal.timestamp;
    if (age > this.signalTtlMs) {
      this.signals.delete(serviceId);
      return undefined;
    }

    return signal;
  }

  /**
   * Clear all recorded signals.
   */
  clear(): void {
    this.signals.clear();
  }
}

/**
 * Express/Koa middleware to add backpressure headers to responses.
 * 
 * @example
 * ```typescript
 * // Express
 * app.use(createBackpressureMiddleware({
 *   getLoadLevel: () => {
 *     // Return current load (0.0 to 1.0)
 *     return process.memoryUsage().heapUsed / maxHeap;
 *   }
 * }));
 * ```
 */
export function createBackpressureMiddleware(options: {
  /** Function to get current load level (0.0 to 1.0) */
  getLoadLevel: () => number | Promise<number>;
  
  /** Threshold above which to signal overload (default: 0.8) */
  overloadThreshold?: number;
  
  /** Suggested retry delay when overloaded, in seconds (default: 5) */
  retryAfterSeconds?: number;
}): (req: any, res: any, next: () => void) => Promise<void> {
  const { 
    getLoadLevel, 
    overloadThreshold = 0.8,
    retryAfterSeconds = 5,
  } = options;

  return async (_req: any, res: any, next: () => void) => {
    const loadLevel = await getLoadLevel();
    
    // Always send load level
    res.setHeader(BACKPRESSURE_HEADERS.LOAD_LEVEL, loadLevel.toFixed(2));
    
    // Signal overload if above threshold
    if (loadLevel >= overloadThreshold) {
      res.setHeader(BACKPRESSURE_HEADERS.SHEDDING, 'true');
      res.setHeader(BACKPRESSURE_HEADERS.RETRY_AFTER, retryAfterSeconds.toString());
    }
    
    next();
  };
}

/**
 * Request counter that tracks active concurrent requests.
 * Use with Express/Koa middleware to automatically track load.
 * 
 * @example
 * ```typescript
 * const counter = new RequestCounter();
 * 
 * // Express middleware
 * app.use(counter.middleware());
 * 
 * // Use in backpressure middleware
 * app.use(createBackpressureMiddleware({
 *   getLoadLevel: () => counter.getCount() / 100,
 * }));
 * ```
 */
export class RequestCounter {
  private count: number = 0;
  private maxObserved: number = 0;

  /**
   * Get current active request count.
   */
  getCount(): number {
    return this.count;
  }

  /**
   * Get maximum observed concurrent requests.
   */
  getMaxObserved(): number {
    return this.maxObserved;
  }

  /**
   * Increment counter (call when request starts).
   */
  increment(): void {
    this.count++;
    if (this.count > this.maxObserved) {
      this.maxObserved = this.count;
    }
  }

  /**
   * Decrement counter (call when request ends).
   */
  decrement(): void {
    this.count = Math.max(0, this.count - 1);
  }

  /**
   * Express/Connect middleware that automatically tracks requests.
   */
  middleware(): (req: any, res: any, next: () => void) => void {
    return (_req: any, res: any, next: () => void) => {
      this.increment();
      
      let decremented = false;
      const onFinish = () => {
        if (!decremented) {
          decremented = true;
          this.decrement();
        }
      };
      
      res.on('finish', onFinish);
      res.on('close', onFinish);
      
      next();
    };
  }

  /**
   * Reset the counter.
   */
  reset(): void {
    this.count = 0;
    this.maxObserved = 0;
  }
}

/**
 * Helper to create a load level calculator based on common metrics.
 * 
 * @example
 * ```typescript
 * const getLoadLevel = createLoadLevelCalculator({
 *   maxConcurrentRequests: 100,
 *   getCurrentRequests: () => activeRequestCount,
 *   maxMemoryMb: 512,
 *   maxCpuPercent: 80,
 * });
 * ```
 */
export function createLoadLevelCalculator(options: {
  /** Maximum concurrent requests before considered overloaded */
  maxConcurrentRequests?: number;
  /** Function to get current concurrent request count */
  getCurrentRequests?: () => number;
  /** Maximum memory in MB before considered overloaded */
  maxMemoryMb?: number;
  /** Maximum CPU percentage before considered overloaded */
  maxCpuPercent?: number;
  /** Function to get current CPU percentage (0-100) */
  getCpuPercent?: () => number;
}): () => number {
  return () => {
    const levels: number[] = [];

    // Request-based load
    if (options.maxConcurrentRequests && options.getCurrentRequests) {
      const requestLoad = options.getCurrentRequests() / options.maxConcurrentRequests;
      levels.push(Math.min(1, requestLoad));
    }

    // Memory-based load
    if (options.maxMemoryMb) {
      const memoryMb = process.memoryUsage().heapUsed / (1024 * 1024);
      const memoryLoad = memoryMb / options.maxMemoryMb;
      levels.push(Math.min(1, memoryLoad));
    }

    // CPU-based load
    if (options.maxCpuPercent && options.getCpuPercent) {
      const cpuLoad = options.getCpuPercent() / options.maxCpuPercent;
      levels.push(Math.min(1, cpuLoad));
    }

    // Return max of all load indicators
    return levels.length > 0 ? Math.max(...levels) : 0;
  };
}
