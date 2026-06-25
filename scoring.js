const WEIGHTS = {
  financial: 0.35,
  audit: 0.25,
  compliance: 0.25,
  geo: 0.15,
};

const DIM_META = [
  { id: 'financial',  barId: 'barFinancial',  val1: 'valFinancial',  val2: 'valFinancial2',  label: 'Financial health',   weight: 0.35 },
  { id: 'audit',      barId: 'barAudit',      val1: 'valAudit',      val2: 'valAudit2',      label: 'Audit history',      weight: 0.25 },
  { id: 'compliance', barId: 'barCompliance', val1: 'valCompliance', val2: 'valCompliance2', label: 'Compliance status',  weight: 0.25 },
  { id: 'geo',        barId: 'barGeo',        val1: 'valGeo',        val2: 'valGeo2',        label: 'Geo & ESG risk',     weight: 0.15 },
];

const EXAMPLES = [
  { name: 'Acme Logistics Ltd',  financial: 88, audit: 82, compliance: 85, geo: 79 },
  { name: 'Meridian Parts Co',   financial: 63, audit: 47, compliance: 58, geo: 44 },
  { name: 'Delta Raw Materials', financial: 28, audit: 31, compliance: 22, geo: 38 },
];

// ── Pure scoring helpers ──────────────────────────────────────────────────────

function composite(f, a, c, g) {
  return Math.round(f * WEIGHTS.financial + a * WEIGHTS.audit + c * WEIGHTS.compliance + g * WEIGHTS.geo);
}

function tier(score) {
  if (score >= 70) return { label: 'Fast-track',     cls: 'tier-green' };
  if (score >= 40) return { label: 'Standard review', cls: 'tier-amber' };
  return               { label: 'Enhanced DD',        cls: 'tier-red'   };
}

function recommendation(score) {
  if (score >= 70) return { label: 'Approve',              cls: 'rec-approve'     };
  if (score >= 40) return { label: 'Conditional approval', cls: 'rec-conditional' };
  return               { label: 'Reject',               cls: 'rec-reject'      };
}

function confidence(f, a, c, g) {
  const vals = [f, a, c, g];
  const boundaries = [40, 70];
  const nearBoundary = vals.some(v => boundaries.some(b => Math.abs(v - b) <= 10));
  if (nearBoundary) return { label: 'Low confidence', cls: 'conf-low' };
  const allHigh = vals.every(v => v > 60);
  const allLow  = vals.every(v => v < 40);
  if (allHigh || allLow) return { label: 'High confidence', cls: 'conf-high' };
  return { label: 'Medium confidence', cls: 'conf-mid' };
}

function explain(score, f, a, c, g) {
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

// ── Card update ───────────────────────────────────────────────────────────────

function currentDimValues() {
  return {
    f: +document.getElementById('financial').value,
    a: +document.getElementById('audit').value,
    c: +document.getElementById('compliance').value,
    g: +document.getElementById('geo').value,
  };
}

function updateCard() {
  const name = document.getElementById('supplierName').value.trim() || 'Unnamed Supplier';
  const { f, a, c, g } = currentDimValues();

  const score = composite(f, a, c, g);
  const t     = tier(score);
  const rec   = recommendation(score);
  const conf  = confidence(f, a, c, g);

  document.getElementById('cardName').textContent      = name;
  document.getElementById('compositeScore').textContent = score;
  document.getElementById('tierBadge').textContent     = t.label;
  document.getElementById('tierBadge').className       = 'tier-badge ' + t.cls;
  document.getElementById('explainText').textContent   = explain(score, f, a, c, g);
  document.getElementById('recLabel').textContent      = rec.label;
  document.getElementById('recLabel').className        = 'rec-pill ' + rec.cls;

  const confEl = document.getElementById('confidenceLabel');
  confEl.textContent  = conf.label;
  confEl.className    = 'confidence-label ' + conf.cls;

  updateActionButtons(t.cls);

  const dimValues = [f, a, c, g];
  DIM_META.forEach((dim, i) => {
    const v = dimValues[i];
    setBar(dim.barId, v);
    document.getElementById(dim.val1).textContent = v;
    document.getElementById(dim.val2).textContent = v;
  });

  const ring = document.getElementById('scoreRing');
  const circumference = 2 * Math.PI * 54;
  ring.style.strokeDasharray  = circumference;
  ring.style.strokeDashoffset = circumference * (1 - score / 100);
  ring.style.stroke = score >= 70 ? '#16a34a' : score >= 40 ? '#d97706' : '#dc2626';
}

function setBar(id, value) {
  const fill = document.getElementById(id);
  fill.style.width      = value + '%';
  fill.style.background = value >= 70 ? '#16a34a' : value >= 40 ? '#d97706' : '#dc2626';
}

// ── Example presets ───────────────────────────────────────────────────────────

function loadExample(idx) {
  const s = EXAMPLES[idx];
  document.getElementById('supplierName').value = s.name;
  document.getElementById('financial').value    = s.financial;
  document.getElementById('audit').value        = s.audit;
  document.getElementById('compliance').value   = s.compliance;
  document.getElementById('geo').value          = s.geo;
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
  const name  = document.getElementById('cardName').textContent;
  const note  = document.getElementById('spocNotes').value.trim();
  const score = +document.getElementById('compositeScore').textContent;
  const tierEl = document.getElementById('tierBadge');
  const tierLabel = tierEl.textContent;
  const tierCls   = tierEl.className.replace('tier-badge ', '');

  const now     = new Date();
  const ts      = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateStr = now.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
  const fullTs  = `${dateStr}, ${ts}`;

  // Banner
  const banner = document.getElementById('decisionBanner');
  const noteFragment = note ? ` — "${note}"` : '';
  banner.textContent = `Decision recorded: ${decision} — Supplier ${name} — ${fullTs}${noteFragment}`;
  banner.className   = 'decision-banner banner-' + decision.toLowerCase();

  // Lock buttons
  ['btnApprove', 'btnEscalate', 'btnReject'].forEach(id => { document.getElementById(id).disabled = true; });
  document.getElementById('btnReset').classList.remove('hidden');

  // Append to history log
  appendHistory({ name, score, tierLabel, tierCls, decision, note, fullTs });
}

function resetDecision() {
  const banner = document.getElementById('decisionBanner');
  banner.className = 'decision-banner hidden';
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
    const track = document.getElementById(dim.barId).closest('.bar-hover-zone');

    track.addEventListener('mouseenter', () => {
      const vals = currentDimValues();
      const dimVal = [vals.f, vals.a, vals.c, vals.g][i];
      const contrib = (dimVal * dim.weight).toFixed(1);
      const pctLabel = Math.round(dim.weight * 100) + '%';
      tooltip.textContent = `${dim.label}: ${dimVal} × ${pctLabel} = ${contrib} pts contributed to total score`;
      tooltip.classList.remove('hidden');
    });

    track.addEventListener('mousemove', e => {
      tooltip.style.left = (e.clientX + 14) + 'px';
      tooltip.style.top  = (e.clientY - 36) + 'px';
    });

    track.addEventListener('mouseleave', () => {
      tooltip.classList.add('hidden');
    });
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