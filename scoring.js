const WEIGHTS = {
  financial: 0.35,
  audit: 0.25,
  compliance: 0.25,
  geo: 0.15,
};

const DIM_META = [
  { id: 'financial',  barId: 'barFinancial',  val1: 'valFinancial',  val2: 'valFinancial2',  label: 'Financial health',  weight: 0.35 },
  { id: 'audit',      barId: 'barAudit',      val1: 'valAudit',      val2: 'valAudit2',      label: 'Audit history',     weight: 0.25 },
  { id: 'compliance', barId: 'barCompliance', val1: 'valCompliance', val2: 'valCompliance2', label: 'Compliance status', weight: 0.25 },
  { id: 'geo',        barId: 'barGeo',        val1: 'valGeo',        val2: 'valGeo2',        label: 'Geo & ESG risk',    weight: 0.15 },
];

const EXAMPLES = [
  { name: 'Acme Logistics Ltd',  financial: 88, audit: 82, compliance: 85, geo: 79 },
  { name: 'Meridian Parts Co',   financial: 63, audit: 47, compliance: 58, geo: 44 },
  { name: 'Delta Raw Materials', financial: 28, audit: 31, compliance: 22, geo: 38 },
];

const OLLAMA_URL   = 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = 'mistral';

let currentAbortController = null;
let debounceTimer = null;

// ── Fallback (rule-based) helpers ─────────────────────────────────────────────

function compositeRuleBased(f, a, c, g) {
  return Math.round(f * WEIGHTS.financial + a * WEIGHTS.audit + c * WEIGHTS.compliance + g * WEIGHTS.geo);
}

function explainRuleBased(score, f, a, c, g) {
  if (score >= 70) {
    if (f >= 80 && c >= 70) return 'Strong financials and solid compliance make this supplier low-risk and ready to onboard.';
    if (g < 60) return 'Strong financials and audit history offset moderate geo and ESG exposure.';
    return 'Healthy scores across all dimensions. This supplier presents minimal onboarding risk.';
  }
  if (score >= 40) {
    if (f >= 70 && (a < 55 || c < 55)) return 'Strong financials offset moderate compliance gaps. Address audit history before full approval.';
    if (g < 45) return 'Elevated geo and ESG risk drags the overall score. Mitigation controls recommended.';
    if (a < 50) return 'Audit history is the primary concern. Request recent third-party audit documentation.';
    return 'Mixed profile — some dimensions are acceptable, but gaps require standard due diligence review.';
  }
  if (a < 35 && g < 45) return 'High geo risk and poor audit history flag this supplier for deep review before any engagement.';
  if (c < 35) return 'Critical compliance failures identified. Reject unless supplier can demonstrate immediate remediation.';
  if (f < 35) return 'Severe financial instability poses a supply continuity risk. Enhanced due diligence required.';
  return 'Multiple high-risk dimensions detected. This supplier requires enhanced due diligence before consideration.';
}

// ── Tier / recommendation / confidence ───────────────────────────────────────

function tier(score) {
  if (score >= 70) return { label: 'Fast-track',      cls: 'tier-green' };
  if (score >= 40) return { label: 'Standard review',  cls: 'tier-amber' };
  return               { label: 'Enhanced DD',         cls: 'tier-red'   };
}

function recommendation(score) {
  if (score >= 70) return { label: 'Approve',              cls: 'rec-approve'     };
  if (score >= 40) return { label: 'Conditional approval', cls: 'rec-conditional' };
  return               { label: 'Reject',               cls: 'rec-reject'      };
}

function confidence(f, a, c, g) {
  const vals = [f, a, c, g];
  const nearBoundary = vals.some(v => [40, 70].some(b => Math.abs(v - b) <= 10));
  if (nearBoundary) return { label: 'Low confidence',    cls: 'conf-low'  };
  if (vals.every(v => v > 60) || vals.every(v => v < 40))
    return { label: 'High confidence',   cls: 'conf-high' };
  return { label: 'Medium confidence', cls: 'conf-mid'  };
}

// ── Ollama API ────────────────────────────────────────────────────────────────

async function askOllama(prompt, signal) {
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  return data.response;
}

async function fetchAiScore(f, a, c, g, signal) {
  const prompt =
    `You are a supplier risk analyst. Given these four dimension scores out of 100: ` +
    `Financial health: ${f}, Audit history: ${a}, Compliance status: ${c}, Geo & ESG risk: ${g}. ` +
    `Return ONLY a valid JSON object with no explanation, no markdown, no backticks. ` +
    `Just raw JSON like this: {"score": 74, "financial": 88, "audit": 82, "compliance": 85, "geo": 79}. ` +
    `The composite score should reflect the overall supplier risk. Higher score = lower risk.`;
  const raw = await askOllama(prompt, signal);
  const cleaned = raw.trim().replace(/```json|```/g, '').replace(/\\"/g, '"').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('AI response was not valid JSON');
  }

  const clamp = (val, fallback) => {
    const n = Math.round(Number(val));
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback;
  };

  const fallbackScore = compositeRuleBased(f, a, c, g);
  return {
    score:      clamp(parsed.score,      fallbackScore),
    financial:  clamp(parsed.financial,  f),
    audit:      clamp(parsed.audit,      a),
    compliance: clamp(parsed.compliance, c),
    geo:        clamp(parsed.geo,        g),
  };
}

async function fetchAiExplain(f, a, c, g, score, tierLabel, signal) {
  const prompt =
    `You are a supplier risk analyst. A supplier has been scored as follows: ` +
    `Financial health: ${f}/100, Audit history: ${a}/100, Compliance status: ${c}/100, ` +
    `Geo & ESG risk: ${g}/100, Composite risk score: ${score}/100, Risk tier: ${tierLabel}. ` +
    `Write a single short paragraph (2-3 sentences max) explaining why this supplier received this score ` +
    `and what the SPOC should focus on. Be specific. No bullet points. Plain text only.`;
  return await askOllama(prompt, signal);
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function setLoading(on) {
  if (on) {
    document.getElementById('compositeScore').textContent = '…';
    document.getElementById('explainText').textContent    = 'Analysing with AI…';
  }
}

function setAiNotice(show) {
  let el = document.getElementById('aiNotice');
  if (!el) {
    el = document.createElement('div');
    el.id = 'aiNotice';
    el.className = 'ai-notice hidden';
    document.querySelector('.explain-block').insertAdjacentElement('beforebegin', el);
  }
  el.textContent = show ? 'AI unavailable — using rule-based scoring' : '';
  el.classList.toggle('hidden', !show);
}

function renderCard({ name, score, subScores, explainText, f, a, c, g }) {
  const safeScore = Number.isFinite(score) ? score : compositeRuleBased(f, a, c, g);

  const t    = tier(safeScore);
  const rec  = recommendation(safeScore);
  const conf = confidence(f, a, c, g);

  document.getElementById('cardName').textContent       = name;
  document.getElementById('compositeScore').textContent = safeScore;
  document.getElementById('tierBadge').textContent      = t.label;
  document.getElementById('tierBadge').className        = 'tier-badge ' + t.cls;
  document.getElementById('explainText').textContent    = explainText;
  document.getElementById('recLabel').textContent       = rec.label;
  document.getElementById('recLabel').className         = 'rec-pill ' + rec.cls;

  const confEl = document.getElementById('confidenceLabel');
  confEl.textContent = conf.label;
  confEl.className   = 'confidence-label ' + conf.cls;

  updateActionButtons(t.cls);

  const displayVals = subScores
    ? [subScores.financial, subScores.audit, subScores.compliance, subScores.geo]
    : [f, a, c, g];

  DIM_META.forEach((dim, i) => {
    const v = displayVals[i];
    setBar(dim.barId, v);
    document.getElementById(dim.val1).textContent = v;
    document.getElementById(dim.val2).textContent = v;
  });

  const ring = document.getElementById('scoreRing');
  const circumference = 2 * Math.PI * 54;
  ring.style.strokeDasharray  = circumference;
  ring.style.strokeDashoffset = circumference * (1 - safeScore / 100);
  ring.style.stroke = safeScore >= 70 ? '#16a34a' : safeScore >= 40 ? '#d97706' : '#dc2626';
}

function setBar(id, value) {
  const fill = document.getElementById(id);
  fill.style.width      = value + '%';
  fill.style.background = value >= 70 ? '#16a34a' : value >= 40 ? '#d97706' : '#dc2626';
}

// ── Main update ───────────────────────────────────────────────────────────────

function updateCard() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runUpdate, 400);
}

async function runUpdate() {
  if (currentAbortController) currentAbortController.abort();
  currentAbortController = new AbortController();
  const signal = currentAbortController.signal;

  const name = document.getElementById('supplierName').value.trim() || 'Unnamed Supplier';
  const f = +document.getElementById('financial').value;
  const a = +document.getElementById('audit').value;
  const c = +document.getElementById('compliance').value;
  const g = +document.getElementById('geo').value;

  document.getElementById('cardName').textContent = name;
  DIM_META.forEach((dim, i) => {
    const v = [f, a, c, g][i];
    document.getElementById(dim.val1).textContent = v;
    document.getElementById(dim.val2).textContent = v;
  });

  const ring = document.getElementById('scoreRing');
  const circumference = 2 * Math.PI * 54;
  ring.style.strokeDasharray  = circumference;
  ring.style.strokeDashoffset = circumference;
  ring.style.stroke = '#e2e8f0';

  const quickScore = compositeRuleBased(f, a, c, g);
  const quickTier  = tier(quickScore);
  document.getElementById('tierBadge').textContent = quickTier.label;
  document.getElementById('tierBadge').className   = 'tier-badge ' + quickTier.cls;
  updateActionButtons(quickTier.cls);
  DIM_META.forEach((dim, i) => setBar(dim.barId, [f, a, c, g][i]));
  const quickRec = recommendation(quickScore);
  document.getElementById('recLabel').textContent = quickRec.label;
  document.getElementById('recLabel').className   = 'rec-pill ' + quickRec.cls;

  setLoading(true);

  try {
    const scoreData = await fetchAiScore(f, a, c, g, signal);
    if (signal.aborted) return;

    const t = tier(scoreData.score);
    const explainText = await fetchAiExplain(f, a, c, g, scoreData.score, t.label, signal);
    if (signal.aborted) return;

    setAiNotice(false);
    renderCard({ name, score: scoreData.score, subScores: scoreData, explainText: explainText.trim(), f, a, c, g });

  } catch (err) {
    if (signal.aborted) return;
    console.warn('[AI] Falling back to rule-based:', err.message);
    const score       = compositeRuleBased(f, a, c, g);
    const explainText = explainRuleBased(score, f, a, c, g);
    setAiNotice(true);
    renderCard({ name, score, subScores: null, explainText, f, a, c, g });
  }
}

// ── Example presets ───────────────────────────────────────────────────────────

function loadExample(idx) {
  const s = EXAMPLES[idx];
  document.getElementById('supplierName').value  = s.name;
  document.getElementById('financial').value     = s.financial;
  document.getElementById('audit').value         = s.audit;
  document.getElementById('compliance').value    = s.compliance;
  document.getElementById('geo').value           = s.geo;
  updateCard();
  document.querySelectorAll('.example-btn').forEach((b, i) => b.classList.toggle('active', i === idx));
}

// ── Action buttons ────────────────────────────────────────────────────────────

function updateActionButtons(tierCls) {
  const map = { 'tier-green': 'approve', 'tier-amber': 'escalate', 'tier-red': 'reject' };
  const suggested = map[tierCls];
  ['approve', 'escalate', 'reject'].forEach(action => {
    const btn = document.getElementById('btn' + action.charAt(0).toUpperCase() + action.slice(1));
    btn.classList.toggle('suggested', action === suggested);
  });
}

function recordDecision(decision) {
  const name      = document.getElementById('cardName').textContent;
  const note      = document.getElementById('spocNotes').value.trim();
  const score     = +document.getElementById('compositeScore').textContent;
  const tierEl    = document.getElementById('tierBadge');
  const tierLabel = tierEl.textContent;
  const tierCls   = tierEl.className.replace('tier-badge ', '');

  const now     = new Date();
  const ts      = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateStr = now.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
  const fullTs  = `${dateStr}, ${ts}`;

  const banner = document.getElementById('decisionBanner');
  banner.textContent = `Decision recorded: ${decision} — Supplier ${name} — ${fullTs}${note ? ` — "${note}"` : ''}`;
  banner.className   = 'decision-banner banner-' + decision.toLowerCase();

  ['btnApprove', 'btnEscalate', 'btnReject'].forEach(id => { document.getElementById(id).disabled = true; });
  document.getElementById('btnReset').classList.remove('hidden');

  appendHistory({ name, score, tierLabel, tierCls, decision, note, fullTs });
}

function resetDecision() {
  const banner = document.getElementById('decisionBanner');
  banner.className   = 'decision-banner hidden';
  banner.textContent = '';
  document.getElementById('spocNotes').value = '';
  ['btnApprove', 'btnEscalate', 'btnReject'].forEach(id => { document.getElementById(id).disabled = false; });
  document.getElementById('btnReset').classList.add('hidden');
  updateCard();
}

// ── Decision history ──────────────────────────────────────────────────────────

function appendHistory({ name, score, tierLabel, tierCls, decision, note, fullTs }) {
  document.getElementById('historyEmpty').classList.add('hidden');
  const table = document.getElementById('historyTable');
  table.classList.remove('hidden');

  const decisionCls = { Approve: 'dec-approve', Escalate: 'dec-escalate', Reject: 'dec-reject' }[decision] || '';
  const tbody = document.getElementById('historyBody');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="h-name">${escHtml(name)}</td>
    <td class="h-score">${score}</td>
    <td><span class="tier-badge ${tierCls}">${escHtml(tierLabel)}</span></td>
    <td><span class="history-decision ${decisionCls}">${escHtml(decision)}</span></td>
    <td class="h-note">${note ? escHtml(note) : '<span class="h-empty">—</span>'}</td>
    <td class="h-ts">${escHtml(fullTs)}</td>`;
  tbody.insertBefore(tr, tbody.firstChild);
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Tooltip ───────────────────────────────────────────────────────────────────

function initTooltips() {
  const tooltip = document.getElementById('tooltip');

  DIM_META.forEach((dim, i) => {
    const zone = document.getElementById(dim.barId).closest('.bar-hover-zone');
    if (!zone) return;

    zone.addEventListener('mouseenter', () => {
      const vals   = { f: +document.getElementById('financial').value, a: +document.getElementById('audit').value, c: +document.getElementById('compliance').value, g: +document.getElementById('geo').value };
      const dimVal = [vals.f, vals.a, vals.c, vals.g][i];
      const contrib  = (dimVal * dim.weight).toFixed(1);
      const pctLabel = Math.round(dim.weight * 100) + '%';
      tooltip.textContent = `${dim.label}: ${dimVal} × ${pctLabel} = ${contrib} pts contributed to total score`;
      tooltip.classList.remove('hidden');
    });

    zone.addEventListener('mousemove', e => {
      tooltip.style.left = (e.clientX + 14) + 'px';
      tooltip.style.top  = (e.clientY - 36) + 'px';
    });

    zone.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  ['supplierName', 'financial', 'audit', 'compliance', 'geo'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateCard);
  });

  document.querySelectorAll('.example-btn').forEach((btn, i) => {
    btn.addEventListener('click', () => loadExample(i));
  });

  document.getElementById('btnApprove').addEventListener('click',  () => recordDecision('Approve'));
  document.getElementById('btnEscalate').addEventListener('click', () => recordDecision('Escalate'));
  document.getElementById('btnReject').addEventListener('click',   () => recordDecision('Reject'));
  document.getElementById('btnReset').addEventListener('click', resetDecision);
  document.getElementById('btnExport').addEventListener('click', () => window.print());

  initTooltips();
  loadExample(0);
});