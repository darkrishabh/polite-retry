const controls = {
  failureRate: document.getElementById('failureRate'),
  retryCount: document.getElementById('retryCount'),
  serviceDepth: document.getElementById('serviceDepth'),
  baseLoad: document.getElementById('baseLoad'),
  jitterToggle: document.getElementById('jitterToggle'),
  backoffToggle: document.getElementById('backoffToggle'),
  mode: [...document.querySelectorAll('input[name="scenarioMode"]')],
};

const outputs = {
  failureRate: document.getElementById('failureRateValue'),
  retryCount: document.getElementById('retryCountValue'),
  serviceDepth: document.getElementById('serviceDepthValue'),
  baseLoad: document.getElementById('baseLoadValue'),
  standardRaf: document.getElementById('standardRaf'),
  standardVolume: document.getElementById('standardVolume'),
  standardSuccess: document.getElementById('standardSuccess'),
  standardCost: document.getElementById('standardCost'),
  standardStatus: document.getElementById('standardStatus'),
  standardCostLabel: document.getElementById('standardCostLabel'),
  budgetRaf: document.getElementById('budgetRaf'),
  budgetVolume: document.getElementById('budgetVolume'),
  budgetSuccess: document.getElementById('budgetSuccess'),
  budgetCost: document.getElementById('budgetCost'),
  budgetStatus: document.getElementById('budgetStatus'),
  budgetCostLabel: document.getElementById('budgetCostLabel'),
};

const stages = {
  standard: document.getElementById('standardFlow'),
  budget: document.getElementById('budgetFlow'),
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function getState() {
  return {
    failureRate: Number(controls.failureRate.value) / 100,
    retryCount: Number(controls.retryCount.value),
    serviceDepth: Number(controls.serviceDepth.value),
    baseLoad: Number(controls.baseLoad.value),
    jitter: controls.jitterToggle.checked,
    backoff: controls.backoffToggle.checked,
    mode: controls.mode.find((control) => control.checked)?.value ?? 'service',
  };
}

function naiveRaf({ failureRate, retryCount, serviceDepth }) {
  if (retryCount === 0 || failureRate === 0) return 1;
  if (failureRate === 1) return Math.pow(retryCount + 1, serviceDepth);

  const attemptsPerTier = (1 - Math.pow(failureRate, retryCount + 1)) / (1 - failureRate);
  return Math.pow(attemptsPerTier, serviceDepth);
}

function strategyMetrics(state) {
  const rawStandardRaf = naiveRaf(state);
  const timingRelief = (state.jitter ? 0.1 : 0) + (state.backoff ? 0.14 : 0);
  const standardRaf = Math.max(1, rawStandardRaf * (1 - timingRelief));
  const capacityLimit = state.mode === 'ai' ? 1.8 : 2.4;
  const overload = clamp((standardRaf - capacityLimit) / (capacityLimit * 2), 0, 1);
  const noRetryBaseline = clamp(1 - state.failureRate * (0.9 + state.serviceDepth * 0.03), 0.04, 0.99);
  const standardRecovery = 1 - Math.pow(state.failureRate, state.retryCount + 1);
  const standardSuccess = clamp(
    noRetryBaseline + (standardRecovery - noRetryBaseline) * 0.55 - overload * 0.42,
    0.02,
    0.99,
  );

  const pressureBudget = state.failureRate > 0.3 ? 0.08 : 0.18;
  const budgetCap = 1 + pressureBudget + (state.jitter ? 0.02 : 0.06) + (state.backoff ? 0 : 0.05);
  const budgetRaf = Math.min(standardRaf, budgetCap);
  const budgetOverload = clamp((budgetRaf - capacityLimit) / capacityLimit, 0, 1);
  const budgetSuccess = clamp(noRetryBaseline + (1 - noRetryBaseline) * 0.12 - budgetOverload * 0.2, 0.02, 0.99);

  return {
    standard: {
      raf: standardRaf,
      volume: Math.round(state.baseLoad * standardRaf),
      success: standardSuccess,
      pressure: overload,
    },
    budget: {
      raf: budgetRaf,
      volume: Math.round(state.baseLoad * budgetRaf),
      success: budgetSuccess,
      pressure: budgetOverload,
    },
  };
}

function pressureText(pressure, mode, raf) {
  if (mode === 'ai') return `${raf.toFixed(2)}x tokens`;
  if (pressure > 0.66) return 'Critical';
  if (pressure > 0.28) return 'High';
  return 'Low';
}

function statusText(pressure) {
  if (pressure > 0.66) return ['Collapse', 'status-danger'];
  if (pressure > 0.28) return ['Overload', 'status-warn'];
  return ['Stable', 'status-ok'];
}

function scenarioLabels(mode, depth) {
  const serviceLabels = ['Client', 'API', 'Service A', 'Service B', 'Database', 'Provider'];
  const aiLabels = ['User', 'Agent', 'LLM API', 'Embeddings', 'Vector DB', 'Tool API'];
  return (mode === 'ai' ? aiLabels : serviceLabels).slice(0, depth + 1);
}

function splitLabel(label) {
  const parts = label.split(' ');
  if (parts.length === 1) return [label];
  const midpoint = Math.ceil(parts.length / 2);
  return [parts.slice(0, midpoint).join(' '), parts.slice(midpoint).join(' ')];
}

function renderFlow(stage, metrics, state, variant) {
  const tiers = scenarioLabels(state.mode, state.serviceDepth);
  const startX = 60;
  const endX = 356;
  const gap = tiers.length > 1 ? (endX - startX) / (tiers.length - 1) : 0;
  const nodeWidth = 74;
  const nodeHeight = 58;
  const nodeY = 98;
  const totalVolume = Math.round(state.baseLoad * metrics.raf);
  const retryVolume = Math.max(0, totalVolume - state.baseLoad);
  const graphState = metrics.pressure > 0.28
    ? variant === 'standard' ? 'hot' : 'protected'
    : 'stable';

  const nodes = tiers.map((label, index) => ({
    label,
    x: startX + index * gap,
    y: nodeY,
    isEntry: index === 0,
    isTerminal: index === tiers.length - 1,
  }));

  const edges = nodes.slice(0, -1).map((node, index) => {
    const next = nodes[index + 1];
    const left = node.x + nodeWidth / 2;
    const right = next.x - nodeWidth / 2;
    return `
      <line class="graph-link graph-link-${graphState}" x1="${left}" y1="${nodeY}" x2="${right}" y2="${nodeY}" />
      <polygon class="graph-arrow graph-arrow-${graphState}" points="${right},${nodeY} ${right - 10},${nodeY - 6} ${right - 10},${nodeY + 6}" />
    `;
  }).join('');

  const nodeMarkup = nodes.map((node) => {
    const lines = splitLabel(node.label);
    const nodeClass = node.isTerminal && metrics.pressure > 0.28
      ? 'graph-node node-overloaded'
      : node.isTerminal && variant === 'budget'
        ? 'graph-node node-protected'
        : 'graph-node';
    const volume = node.isEntry ? state.baseLoad : totalVolume;
    return `
      <g class="${nodeClass}" transform="translate(${node.x - nodeWidth / 2}, ${node.y - nodeHeight / 2})">
        <rect width="${nodeWidth}" height="${nodeHeight}" rx="10"></rect>
        <text class="node-title" x="${nodeWidth / 2}" y="${lines.length === 1 ? 25 : 19}">
          ${lines.map((line, lineIndex) => `<tspan x="${nodeWidth / 2}" dy="${lineIndex === 0 ? 0 : 15}">${line}</tspan>`).join('')}
        </text>
        <text class="node-load" x="${nodeWidth / 2}" y="49">${volume} r/s</text>
      </g>
    `;
  }).join('');

  const impactLabel = metrics.pressure > 0.28
    ? variant === 'standard' ? 'Downstream overload' : 'Budget absorbs retries'
    : 'Downstream stable';
  const impactClass = metrics.pressure > 0.28
    ? variant === 'standard' ? 'impact-hot' : 'impact-ok'
    : 'impact-ok';

  stage.innerHTML = `
    <svg class="node-flow-graph" viewBox="0 0 430 232" role="img" aria-label="${variant === 'standard' ? 'Naive retry flow' : 'Adaptive retry budget flow'}">
      <defs>
        <filter id="nodeShadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="7" stdDeviation="7" flood-color="#0f172a" flood-opacity="0.12"></feDropShadow>
        </filter>
      </defs>
      <rect class="graph-surface" x="0" y="0" width="430" height="232" rx="14"></rect>
      <g class="graph-pill graph-pill-entry" transform="translate(16 22)">
        <rect width="118" height="28" rx="8"></rect>
        <text x="59" y="18">${state.baseLoad} r/s enters</text>
      </g>
      <g class="graph-pill ${impactClass}" transform="translate(236 22)">
        <rect width="178" height="28" rx="8"></rect>
        <text x="89" y="18">${impactLabel}</text>
      </g>
      ${edges}
      ${nodeMarkup}
      <g class="retry-impact" transform="translate(16 160)">
        <rect width="398" height="50" rx="10"></rect>
        <text class="summary-primary" x="16" y="21">${state.baseLoad} r/s input becomes ${totalVolume} r/s downstream</text>
        <text class="summary-secondary" x="16" y="38">Retries add ${retryVolume} r/s of extra work</text>
      </g>
    </svg>
  `;
}

function updateUrlState(state) {
  const params = new URLSearchParams({
    failure: String(Math.round(state.failureRate * 100)),
    retries: String(state.retryCount),
    depth: String(state.serviceDepth),
    load: String(state.baseLoad),
    mode: state.mode,
    jitter: state.jitter ? '1' : '0',
    backoff: state.backoff ? '1' : '0',
  });
  history.replaceState(null, '', `${location.pathname}?${params.toString()}`);
}

function render() {
  const state = getState();
  const metrics = strategyMetrics(state);

  outputs.failureRate.textContent = `${Math.round(state.failureRate * 100)}%`;
  outputs.retryCount.textContent = String(state.retryCount);
  outputs.serviceDepth.textContent = `${state.serviceDepth} ${state.serviceDepth === 1 ? 'tier' : 'tiers'}`;
  outputs.baseLoad.textContent = `${state.baseLoad} req/s`;

  outputs.standardRaf.textContent = `${metrics.standard.raf.toFixed(2)}x`;
  outputs.standardVolume.textContent = `${metrics.standard.volume} req/s`;
  outputs.standardSuccess.textContent = `${Math.round(metrics.standard.success * 100)}%`;
  outputs.standardCostLabel.textContent = state.mode === 'ai' ? 'Token multiplier' : 'Queue pressure';
  outputs.standardCost.textContent = pressureText(metrics.standard.pressure, state.mode, metrics.standard.raf);

  outputs.budgetRaf.textContent = `${metrics.budget.raf.toFixed(2)}x`;
  outputs.budgetVolume.textContent = `${metrics.budget.volume} req/s`;
  outputs.budgetSuccess.textContent = `${Math.round(metrics.budget.success * 100)}%`;
  outputs.budgetCostLabel.textContent = state.mode === 'ai' ? 'Token multiplier' : 'Queue pressure';
  outputs.budgetCost.textContent = pressureText(metrics.budget.pressure, state.mode, metrics.budget.raf);

  const [standardLabel, standardClass] = statusText(metrics.standard.pressure);
  const [budgetLabel, budgetClass] = statusText(metrics.budget.pressure);
  outputs.standardStatus.textContent = standardLabel;
  outputs.standardStatus.className = `status-pill ${standardClass}`;
  outputs.budgetStatus.textContent = budgetLabel;
  outputs.budgetStatus.className = `status-pill ${budgetClass}`;

  renderFlow(stages.standard, metrics.standard, state, 'standard');
  renderFlow(stages.budget, metrics.budget, state, 'budget');
  updateUrlState(state);
}

function hydrateFromUrl() {
  const params = new URLSearchParams(location.search);
  const setValue = (key, control) => {
    if (params.has(key)) control.value = params.get(key);
  };

  setValue('failure', controls.failureRate);
  setValue('retries', controls.retryCount);
  setValue('depth', controls.serviceDepth);
  setValue('load', controls.baseLoad);
  controls.jitterToggle.checked = params.get('jitter') !== '0';
  controls.backoffToggle.checked = params.get('backoff') !== '0';

  const mode = params.get('mode');
  if (mode) {
    const modeControl = controls.mode.find((control) => control.value === mode);
    if (modeControl) modeControl.checked = true;
  }
}

document.getElementById('injectFailure').addEventListener('click', () => {
  controls.failureRate.value = 50;
  controls.retryCount.value = 3;
  controls.serviceDepth.value = 3;
  render();
});

document.getElementById('shareScenario').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  try {
    if (!navigator.clipboard) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(location.href);
    button.textContent = 'Copied Link';
  } catch {
    button.textContent = 'Link in URL';
  }
  setTimeout(() => {
    button.textContent = 'Share Scenario';
  }, 1800);
});

[
  controls.failureRate,
  controls.retryCount,
  controls.serviceDepth,
  controls.baseLoad,
  controls.jitterToggle,
  controls.backoffToggle,
  ...controls.mode,
].forEach((control) => control.addEventListener('input', render));

hydrateFromUrl();
render();
