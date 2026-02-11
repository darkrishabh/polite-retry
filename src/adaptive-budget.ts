import { AdaptiveRetryOptions, RetryMetrics } from './types';

/**
 * Adaptive Retry Budgeting (ARB) Manager
 * 
 * Implements the ARB algorithm from:
 * "Retry Amplification in Distributed Systems: A Systematic Analysis of 
 * Retry Policies and Their Role in Cascading Failures"
 * 
 * Key principles:
 * 1. Global awareness: Consider system-wide state, not just local failures
 * 2. Budget conservation: Total retry capacity is a shared resource
 * 3. Graceful degradation: Under stress, prioritize completing some requests
 */
export class AdaptiveRetryBudget {
  // Current retry budget (fraction of base load)
  private budget: number;
  
  // Observed failure rate (exponential moving average)
  private failureRate: number = 0;
  
  // Metrics tracking
  private totalRequests: number = 0;
  private successfulRequests: number = 0;
  private failedRequests: number = 0;
  private totalRetries: number = 0;
  
  // Configuration
  private readonly initialBudget: number;
  private readonly budgetIncreaseRate: number;
  private readonly budgetDecreaseRate: number;
  private readonly highFailureThreshold: number;
  private readonly lowFailureThreshold: number;
  private readonly adjustmentIntervalMs: number;
  private readonly onBudgetChange?: (budget: number, failureRate: number) => void;
  private readonly checkBackpressure?: () => boolean | Promise<boolean>;
  
  // EMA smoothing factor for failure rate
  private readonly emaAlpha: number = 0.1;
  
  // Budget adjustment timer
  private adjustmentTimer: NodeJS.Timeout | null = null;

  constructor(options: AdaptiveRetryOptions = {}) {
    this.initialBudget = options.initialBudget ?? 0.2;
    this.budget = this.initialBudget;
    this.budgetIncreaseRate = options.budgetIncreaseRate ?? 0.1;
    this.budgetDecreaseRate = options.budgetDecreaseRate ?? 0.5;
    this.highFailureThreshold = options.highFailureThreshold ?? 0.3;
    this.lowFailureThreshold = options.lowFailureThreshold ?? 0.05;
    this.adjustmentIntervalMs = options.adjustmentIntervalMs ?? 1000;
    this.onBudgetChange = options.onBudgetChange;
    this.checkBackpressure = options.checkBackpressure;
    
    this.startBudgetAdjustment();
  }

  /**
   * Check if a retry should be attempted based on current budget.
   * 
   * @returns true if retry is allowed, false if budget exhausted or backpressure detected
   */
  async shouldRetry(): Promise<boolean> {
    // Check backpressure signal from downstream
    if (this.checkBackpressure) {
      const isBackpressured = await this.checkBackpressure();
      if (isBackpressured) {
        return false;
      }
    }

    // Check budget
    if (this.budget <= 0) {
      return false;
    }

    // Probabilistic retry based on budget and failure rate
    const retryProbability = Math.min(this.budget, 1 - this.failureRate);
    
    if (Math.random() < retryProbability) {
      // Consume budget
      this.budget = Math.max(0, this.budget - 0.01);
      this.totalRetries++;
      return true;
    }

    return false;
  }

  /**
   * Synchronous version of shouldRetry (ignores backpressure check).
   */
  shouldRetrySync(): boolean {
    if (this.budget <= 0) {
      return false;
    }

    const retryProbability = Math.min(this.budget, 1 - this.failureRate);
    
    if (Math.random() < retryProbability) {
      this.budget = Math.max(0, this.budget - 0.01);
      this.totalRetries++;
      return true;
    }

    return false;
  }

  /**
   * Record the outcome of a request (success or failure).
   * Updates the exponential moving average of failure rate.
   */
  recordOutcome(success: boolean): void {
    this.totalRequests++;
    
    if (success) {
      this.successfulRequests++;
    } else {
      this.failedRequests++;
    }

    // Update failure rate EMA
    const failed = success ? 0 : 1;
    this.failureRate = (1 - this.emaAlpha) * this.failureRate + this.emaAlpha * failed;
  }

  /**
   * Get current retry budget.
   */
  getBudget(): number {
    return this.budget;
  }

  /**
   * Get current failure rate.
   */
  getFailureRate(): number {
    return this.failureRate;
  }

  /**
   * Get collected metrics.
   */
  getMetrics(): RetryMetrics {
    const baseRequests = this.totalRequests - this.totalRetries;
    return {
      totalRequests: this.totalRequests,
      successfulRequests: this.successfulRequests,
      failedRequests: this.failedRequests,
      totalRetries: this.totalRetries,
      failureRate: this.failureRate,
      retryAmplificationFactor: baseRequests > 0 
        ? this.totalRequests / baseRequests 
        : 1,
    };
  }

  /**
   * Reset the budget manager to initial state.
   */
  reset(): void {
    this.budget = this.initialBudget;
    this.failureRate = 0;
    this.totalRequests = 0;
    this.successfulRequests = 0;
    this.failedRequests = 0;
    this.totalRetries = 0;
  }

  /**
   * Stop the budget adjustment timer.
   * Call this when you're done using the budget manager.
   */
  dispose(): void {
    if (this.adjustmentTimer) {
      clearInterval(this.adjustmentTimer);
      this.adjustmentTimer = null;
    }
  }

  /**
   * Start periodic budget adjustment.
   */
  private startBudgetAdjustment(): void {
    this.adjustmentTimer = setInterval(() => {
      this.adjustBudget();
    }, this.adjustmentIntervalMs);

    // Don't prevent Node.js from exiting
    if (this.adjustmentTimer.unref) {
      this.adjustmentTimer.unref();
    }
  }

  /**
   * Adjust budget based on observed failure rate.
   * 
   * From the ARB algorithm:
   * - If failure rate > high threshold: decrease budget
   * - If failure rate < low threshold: increase budget (up to initial)
   */
  private adjustBudget(): void {
    const previousBudget = this.budget;

    if (this.failureRate > this.highFailureThreshold) {
      // Decrease budget during high failure periods
      this.budget = this.budget * (1 - this.budgetDecreaseRate);
    } else if (this.failureRate < this.lowFailureThreshold) {
      // Increase budget during stable periods (capped at initial)
      this.budget = Math.min(this.initialBudget, this.budget + this.budgetIncreaseRate);
    }

    // Notify if budget changed significantly
    if (Math.abs(previousBudget - this.budget) > 0.001) {
      this.onBudgetChange?.(this.budget, this.failureRate);
    }
  }
}
