const WEIGHTS = {
  financial: 0.35,
  audit: 0.25,
  compliance: 0.25,
  geo: 0.15,
};

const EXAMPLES = [
  { name: 'Acme Logistics Ltd', financial: 88, audit: 82, compliance: 85, geo: 79 },
  { name: 'Meridian Parts Co', financial: 63, audit: 47, compliance: 58, geo: 44 },
  { name: 'Delta Raw Materials', financial: 28, audit: 31, compliance: 22, geo: 38 },
];

function composite(f, a, c, g) {
  return Math.round(f * WEIGHTS.financial + a * WEIGHTS.audit + c * WEIGHTS.compliance + g * WEIGHTS.geo);
}

function tier(score) {
  if (score >= 70) return { label: 'Fast-track', cls: 'tier-green' };
  if (score >= 40) return { label: 'Standard review', cls: 'tier-amber' };
  return { label: 'Enhanced DD', cls: 'tier-red' };
}

function recommendation(score) {
  if (score >= 70) return { label: 'Approve', cls: 'rec-approve' };
  if (score >= 40) return { label: 'Conditional approval', cls: 'rec-conditional' };
  return { label: 'Reject', cls: 'rec-reject' };
}

function explain(score, f, a, c, g) {
  const weakest = Math.min(f, a, c, g);
  const strongest = Math.max(f, a, c, g);

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

function updateCard() {
  const name = document.getElementById('supplierName').value.trim() || 'Unnamed Supplier';
  const f = +document.getElementById('financial').value;
  const a = +document.getElementById('audit').value;
  const c = +document.getElementById('compliance').value;
  const g = +document.getElementById('geo').value;

  const score = composite(f, a, c, g);
  const t = tier(score);
  const rec = recommendation(score);

  document.getElementById('cardName').textContent = name;
  document.getElementById('compositeScore').textContent = score;
  document.getElementById('tierBadge').textContent = t.label;
  document.getElementById('tierBadge').className = 'tier-badge ' + t.cls;
  document.getElementById('explainText').textContent = explain(score, f, a, c, g);
  document.getElementById('recLabel').textContent = rec.label;
  document.getElementById('recLabel').className = 'rec-pill ' + rec.cls;

  setBar('barFinancial', f);
  setBar('barAudit', a);
  setBar('barCompliance', c);
  setBar('barGeo', g);

  document.getElementById('valFinancial').textContent = f;
  document.getElementById('valAudit').textContent = a;
  document.getElementById('valCompliance').textContent = c;
  document.getElementById('valGeo').textContent = g;

  document.getElementById('valFinancial2').textContent = f;
  document.getElementById('valAudit2').textContent = a;
  document.getElementById('valCompliance2').textContent = c;
  document.getElementById('valGeo2').textContent = g;

  const ring = document.getElementById('scoreRing');
  const pct = score / 100;
  const circumference = 2 * Math.PI * 54;
  ring.style.strokeDasharray = circumference;
  ring.style.strokeDashoffset = circumference * (1 - pct);
  ring.style.stroke = score >= 70 ? '#16a34a' : score >= 40 ? '#d97706' : '#dc2626';
}

function setBar(id, value) {
  const fill = document.getElementById(id);
  fill.style.width = value + '%';
  fill.style.background = value >= 70 ? '#16a34a' : value >= 40 ? '#d97706' : '#dc2626';
}

function loadExample(idx) {
  const s = EXAMPLES[idx];
  document.getElementById('supplierName').value = s.name;
  document.getElementById('financial').value = s.financial;
  document.getElementById('audit').value = s.audit;
  document.getElementById('compliance').value = s.compliance;
  document.getElementById('geo').value = s.geo;
  updateCard();

  document.querySelectorAll('.example-btn').forEach((b, i) => {
    b.classList.toggle('active', i === idx);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  ['supplierName', 'financial', 'audit', 'compliance', 'geo'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateCard);
  });

  document.querySelectorAll('.example-btn').forEach((btn, i) => {
    btn.addEventListener('click', () => loadExample(i));
  });

  loadExample(0);
});