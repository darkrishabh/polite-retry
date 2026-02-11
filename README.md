# Polite Retry

**Retries that don't overwhelm your servers.**

A smart retry library for TypeScript/JavaScript that prevents retry amplification in distributed systems. Unlike aggressive retry libraries, `polite-retry` knows when to back off.

[![npm version](https://img.shields.io/npm/v/polite-retry.svg)](https://www.npmjs.com/package/polite-retry)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**[Documentation](https://darkrishabh.github.io/polite-retry)** | **[API Reference](https://darkrishabh.github.io/polite-retry/api.html)** | **[Examples](https://darkrishabh.github.io/polite-retry/examples.html)**

Based on research from "Retry Amplification in Distributed Systems: A Systematic Analysis of Retry Policies and Their Role in Cascading Failures."

## The Problem

Naive retry policies can make system failures worse. When a service experiences partial failure:

1. Clients retry failed requests
2. Retried requests add load to an already stressed system
3. Increased load causes more failures
4. More failures trigger more retries
5. **Cascade collapse**

This is called **Retry Amplification**. In a 3-tier system with 50% failure rate and 3 retries per tier, request volume can amplify by **6.6x**.

## The Solution

This library provides three retry strategies with increasing sophistication:

| Strategy | Use Case | Amplification Risk |
|----------|----------|-------------------|
| `retry()` | Simple retries with backoff/jitter | Medium |
| `retryWithCircuitBreaker()` | Stop retrying when service is down | Low |
| `retryWithBudget()` | **Adaptive Retry Budgeting (ARB)** | Very Low |

## Installation

```bash
npm install polite-retry
```

## Quick Start

### Basic Retry with Exponential Backoff

```typescript
import { retry } from 'polite-retry';

const data = await retry(
  async () => {
    const response = await fetch('https://api.example.com/data');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  },
  {
    maxRetries: 3,
    initialDelayMs: 100,
    jitter: 'full', // Prevents synchronized retry storms
  }
);
```

### With Circuit Breaker

```typescript
import { retryWithCircuitBreaker, CircuitBreaker } from 'polite-retry';

const breaker = new CircuitBreaker({
  failureThreshold: 0.5, // Open after 50% failure rate
  windowSize: 10,        // Over last 10 requests
  resetTimeoutMs: 30000, // Try again after 30s
});

const data = await retryWithCircuitBreaker(
  async () => fetchFromService(),
  breaker,
  { maxRetries: 3 }
);
```

### With Adaptive Retry Budgeting (Recommended)

```typescript
import { retryWithBudget, AdaptiveRetryBudget } from 'polite-retry';

// Create a shared budget manager (one per downstream service)
const budget = new AdaptiveRetryBudget({
  initialBudget: 0.2, // Allow 20% retry overhead initially
  highFailureThreshold: 0.3, // Reduce budget when >30% failing
  lowFailureThreshold: 0.05, // Restore budget when <5% failing
  onBudgetChange: (budget, rate) => {
    console.log(`Retry budget: ${(budget * 100).toFixed(1)}%, failure rate: ${(rate * 100).toFixed(1)}%`);
  }
});

// Use for all requests to this service
const data = await retryWithBudget(
  async () => fetchFromService(),
  budget,
  { maxRetries: 3, jitter: 'full' }
);

// Get metrics
console.log(budget.getMetrics());
// { totalRequests: 150, successfulRequests: 140, failedRequests: 10, 
//   totalRetries: 15, failureRate: 0.08, retryAmplificationFactor: 1.11 }

// Clean up when shutting down
budget.dispose();
```

## API Reference

### retry(fn, options)

Basic retry with exponential backoff and jitter.

```typescript
function retry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T>
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxRetries` | number | 3 | Maximum retry attempts |
| `initialDelayMs` | number | 100 | Initial backoff delay |
| `maxDelayMs` | number | 30000 | Maximum backoff delay |
| `backoffMultiplier` | number | 2 | Exponential multiplier |
| `jitter` | string | 'full' | Jitter strategy: 'none', 'full', 'equal', 'decorrelated' |
| `retryIf` | function | always | Predicate to decide if error should trigger retry |
| `onRetry` | function | - | Callback before each retry |
| `timeoutMs` | number | - | Timeout per attempt |

### Jitter Strategies

| Strategy | Formula | Best For |
|----------|---------|----------|
| `none` | `delay` | Testing only (causes retry storms) |
| `full` | `random(0, delay)` | General use - best spread |
| `equal` | `delay/2 + random(0, delay/2)` | When minimum delay is important |
| `decorrelated` | `random(base, prevDelay * 3)` | Correlated retry sequences |

### AdaptiveRetryBudget

The ARB algorithm dynamically adjusts retry budget based on observed failure rates.

```typescript
const budget = new AdaptiveRetryBudget({
  initialBudget: 0.2,        // 20% initial retry overhead
  budgetIncreaseRate: 0.1,   // Increase by 10% when stable
  budgetDecreaseRate: 0.5,   // Decrease by 50% when failing
  highFailureThreshold: 0.3, // >30% failures = reduce budget
  lowFailureThreshold: 0.05, // <5% failures = restore budget
  adjustmentIntervalMs: 1000,
  checkBackpressure: async () => {
    // Optional: check if downstream is signaling overload
    return false;
  }
});
```

### CircuitBreaker

Prevents requests when a service is known to be failing.

```typescript
const breaker = new CircuitBreaker({
  failureThreshold: 0.5,  // 50% failure rate opens circuit
  windowSize: 10,         // Consider last 10 requests
  resetTimeoutMs: 30000,  // Wait 30s before testing
  onStateChange: (state) => console.log(`Circuit: ${state}`)
});

// States: 'closed' (normal), 'open' (blocking), 'half-open' (testing)
```

## Best Practices

### 1. Always Use Jitter

Without jitter, clients retry at synchronized intervals, creating periodic load spikes:

```typescript
// Bad - no jitter
{ jitter: 'none' }

// Good - full jitter
{ jitter: 'full' }
```

### 2. One Budget Per Downstream Service

Share a single `AdaptiveRetryBudget` instance for all requests to the same service:

```typescript
// Good - shared budget
const paymentServiceBudget = new AdaptiveRetryBudget();

app.post('/checkout', async (req, res) => {
  await retryWithBudget(() => paymentService.charge(), paymentServiceBudget);
});

app.post('/refund', async (req, res) => {
  await retryWithBudget(() => paymentService.refund(), paymentServiceBudget);
});
```

### 3. Limit Retry Counts

More than 3-5 retries rarely helps and increases amplification risk:

```typescript
// Industry guidance: 3 retries is usually sufficient
{ maxRetries: 3 }
```

### 4. Use Appropriate Timeouts

Set timeouts to fail fast rather than holding connections:

```typescript
{ timeoutMs: 5000 } // 5 second timeout per attempt
```

### 5. Be Selective About What to Retry

Not all errors should trigger retries:

```typescript
{
  retryIf: (error) => {
    // Don't retry client errors
    if (error.message.includes('400')) return false;
    if (error.message.includes('401')) return false;
    if (error.message.includes('403')) return false;
    
    // Retry server errors and network issues
    return true;
  }
}
```

## Backpressure Signaling

Backpressure allows downstream services to tell upstream callers "I'm overloaded, stop retrying." This prevents retry amplification during failures.

### How It Works

```
┌──────────┐                      ┌──────────┐
│  Client  │ ───── Request ─────► │  Server  │
│          │ ◄─── Response ────── │          │
│          │      + Headers:      │          │
│          │      X-Backpressure: 0.85       │
│          │      Retry-After: 5  │          │
└──────────┘                      └──────────┘
     │                                  │
     │  If X-Backpressure > 0.8         │
     │  → Stop retrying                 │
     │  → Wait Retry-After seconds      │
     └──────────────────────────────────┘
```

### Server Side: Send Backpressure Headers

```typescript
import express from 'express';
import { 
  RequestCounter, 
  createBackpressureMiddleware 
} from 'polite-retry';

const app = express();
const MAX_CONCURRENT = 100;

// Option 1: Use RequestCounter (automatic tracking)
const counter = new RequestCounter();
app.use(counter.middleware());  // Automatically tracks active requests

app.use(createBackpressureMiddleware({
  getLoadLevel: () => counter.getCount() / MAX_CONCURRENT,
  overloadThreshold: 0.8,
}));

// Option 2: Manual tracking (if you need more control)
let activeRequests = 0;

app.use((req, res, next) => {
  activeRequests++;
  res.on('finish', () => activeRequests--);
  res.on('close', () => activeRequests--);
  next();
});

app.use(createBackpressureMiddleware({
  getLoadLevel: () => activeRequests / MAX_CONCURRENT,
  overloadThreshold: 0.8,
}));
```

This adds headers to every response:
- `X-Backpressure: 0.75` - Current load level (0.0 to 1.0)
- `X-Load-Shedding: true` - When overloaded
- `Retry-After: 5` - Suggested wait time in seconds

### Client Side: Respect Backpressure

```typescript
import { 
  retryWithBudget, 
  AdaptiveRetryBudget, 
  BackpressureManager 
} from 'polite-retry';

// Track backpressure signals from each service
const backpressure = new BackpressureManager();

// Create budget that checks backpressure before retrying
const budget = new AdaptiveRetryBudget({
  checkBackpressure: () => backpressure.isOverloaded('payment-service'),
});

// Make requests and record backpressure signals
async function callPaymentService(data: PaymentRequest) {
  const response = await retryWithBudget(
    async () => {
      const res = await fetch('https://payment-service/charge', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      
      // Record backpressure signal from response headers
      backpressure.recordFromHeaders('payment-service', res.headers);
      
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    budget,
    { maxRetries: 3 }
  );
  
  return response;
}
```

### Manual Backpressure (Without Middleware)

If you can't use middleware, add headers manually:

```typescript
app.get('/api/data', (req, res) => {
  const load = activeRequests / maxRequests;
  
  // Always send load level
  res.setHeader('X-Backpressure', load.toFixed(2));
  
  // Signal overload if above 80%
  if (load > 0.8) {
    res.setHeader('X-Load-Shedding', 'true');
    res.setHeader('Retry-After', '5');
    
    // Optionally reject request entirely
    if (load > 0.95) {
      return res.status(503).json({ error: 'Service overloaded' });
    }
  }
  
  // Process request...
});
```

### gRPC Backpressure

For gRPC, use metadata instead of headers:

```typescript
// Server: Add backpressure to trailing metadata
const metadata = new grpc.Metadata();
metadata.set('x-backpressure', loadLevel.toString());
callback(null, response, metadata);

// Client: Extract from trailing metadata
const call = client.getData(request);
call.on('metadata', (metadata) => {
  const load = metadata.get('x-backpressure')[0];
  backpressure.recordSignal('grpc-service', {
    isOverloaded: parseFloat(load) > 0.8,
    loadLevel: parseFloat(load),
  });
});
```

## Metrics and Monitoring

Track retry behavior to detect problems:

```typescript
const budget = new AdaptiveRetryBudget({
  onBudgetChange: (budget, failureRate) => {
    // Send to your metrics system
    metrics.gauge('retry.budget', budget);
    metrics.gauge('retry.failure_rate', failureRate);
  }
});

// Periodically log metrics
setInterval(() => {
  const m = budget.getMetrics();
  metrics.gauge('retry.amplification_factor', m.retryAmplificationFactor);
}, 10000);
```

## License

MIT
