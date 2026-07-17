const MAX_DOCS = 10;
const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx'];
const CONTEXT_CHAR_BUDGET = 16000;

let uploadedDocs = [];
let docIdCounter = 0;

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatTimestamp(date) {
  const ts = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const d  = date.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
  return `${d}, ${ts}`;
}

function hasAllowedExtension(filename) {
  const lower = filename.toLowerCase();
  return ALLOWED_EXTENSIONS.some(ext => lower.endsWith(ext));
}

function escDocHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Error messaging ──────────────────────────────────────────────────────────

function showUploadError(msg) {
  const el = document.getElementById('uploadError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearUploadError() {
  const el = document.getElementById('uploadError');
  el.textContent = '';
  el.classList.add('hidden');
}

// ── File handling ────────────────────────────────────────────────────────────

function handleFiles(fileList) {
  clearUploadError();
  const files = Array.from(fileList);
  if (!files.length) return;

  const rejected = [];
  const accepted = [];

  for (const file of files) {
    if (!hasAllowedExtension(file.name)) {
      rejected.push(file.name);
      continue;
    }
    accepted.push(file);
  }

  if (uploadedDocs.length + accepted.length > MAX_DOCS) {
    const room = Math.max(0, MAX_DOCS - uploadedDocs.length);
    showUploadError(`Maximum ${MAX_DOCS} documents per supplier. ${room ? `Only ${room} more can be added.` : 'Remove a document before adding more.'}`);
    accepted.splice(room);
  }

  if (rejected.length) {
    showUploadError(`Unsupported file type: ${rejected.join(', ')}. Only PDF, DOC, and DOCX are accepted.`);
  }

  const now = new Date();
  accepted.forEach(file => {
    uploadedDocs.push({
      id: ++docIdCounter,
      file,
      name: file.name,
      size: file.size,
      uploadedAt: now,
    });
  });

  renderUploadList();
  updateContinueState();
}

// ── Text extraction ──────────────────────────────────────────────────────────

async function extractPdfText(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim();
    pages.push({ page: i, text });
  }
  return { kind: 'pdf', pages };
}

async function extractDocxText(file) {
  const buf = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buf });
  return { kind: 'docx', text: result.value.replace(/\s+/g, ' ').trim() };
}

async function extractDocumentText(doc) {
  const lower = doc.name.toLowerCase();
  try {
    if (lower.endsWith('.pdf')) {
      doc.extracted = await extractPdfText(doc.file);
    } else if (lower.endsWith('.docx')) {
      doc.extracted = await extractDocxText(doc.file);
    } else {
      // legacy .doc binary format isn't parseable client-side without a heavier
      // dependency; record it as unreadable rather than silently ignoring it.
      doc.extractionError = 'Legacy .doc format could not be parsed — please re-save as .docx or PDF.';
    }
  } catch (err) {
    doc.extractionError = `Could not extract text: ${err.message}`;
  }
}

async function extractAllDocuments() {
  await Promise.all(uploadedDocs.map(extractDocumentText));
}

// Builds the combined, budget-capped text context the AI prompt is grounded in.
function buildDocumentContext() {
  const blocks = [];
  for (const doc of uploadedDocs) {
    if (doc.extractionError) {
      blocks.push(`[${doc.name}] — ${doc.extractionError}`);
      continue;
    }
    if (!doc.extracted) continue;
    if (doc.extracted.kind === 'pdf') {
      doc.extracted.pages.forEach(p => {
        if (p.text) blocks.push(`[${doc.name}, page ${p.page}]\n${p.text}`);
      });
    } else if (doc.extracted.kind === 'docx') {
      if (doc.extracted.text) blocks.push(`[${doc.name}]\n${doc.extracted.text}`);
    }
  }

  let context = blocks.join('\n\n');
  let truncated = false;
  if (context.length > CONTEXT_CHAR_BUDGET) {
    context = context.slice(0, CONTEXT_CHAR_BUDGET);
    truncated = true;
  }
  return { context, truncated, documentNames: uploadedDocs.map(d => d.name) };
}

function removeDoc(id) {
  uploadedDocs = uploadedDocs.filter(d => d.id !== id);
  clearUploadError();
  renderUploadList();
  updateContinueState();
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderUploadList() {
  const empty = document.getElementById('uploadEmpty');
  const table = document.getElementById('uploadTable');
  const tbody = document.getElementById('uploadBody');

  if (!uploadedDocs.length) {
    empty.classList.remove('hidden');
    table.classList.add('hidden');
    tbody.innerHTML = '';
    return;
  }

  empty.classList.add('hidden');
  table.classList.remove('hidden');

  tbody.innerHTML = uploadedDocs.map(doc => `
    <tr>
      <td class="upload-name">${escDocHtml(doc.name)}</td>
      <td class="upload-size">${formatBytes(doc.size)}</td>
      <td class="upload-ts">${formatTimestamp(doc.uploadedAt)}</td>
      <td><button type="button" class="upload-remove-btn" data-doc-id="${doc.id}" title="Remove">✕</button></td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.upload-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeDoc(Number(btn.dataset.docId)));
  });
}

function updateContinueState() {
  document.getElementById('btnContinue').disabled = uploadedDocs.length === 0;
}

// ── View navigation ──────────────────────────────────────────────────────────

function showLanding() {
  document.getElementById('landingView').classList.remove('hidden');
  document.getElementById('workspaceView').classList.add('hidden');
}

function showWorkspace() {
  document.getElementById('landingView').classList.add('hidden');
  document.getElementById('workspaceView').classList.remove('hidden');
}

function resetLanding() {
  uploadedDocs = [];
  clearUploadError();
  document.getElementById('landingSupplierName').value = '';
  document.getElementById('fileInput').value = '';
  renderUploadList();
  updateContinueState();
}

async function continueToScoring() {
  const name = document.getElementById('landingSupplierName').value.trim() || 'Unnamed Supplier';
  document.getElementById('supplierName').value = name;

  const btn = document.getElementById('btnContinue');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Reading documents…';
  clearUploadError();

  try {
    await extractAllDocuments();
  } catch (err) {
    showUploadError(`Document extraction failed: ${err.message}`);
    btn.disabled = false;
    btn.textContent = originalLabel;
    return;
  }

  btn.textContent = originalLabel;
  btn.disabled = false;

  showWorkspace();
  if (typeof updateCard === 'function') updateCard();
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const dropzone   = document.getElementById('dropzone');
  const fileInput  = document.getElementById('fileInput');
  const browseBtn  = document.getElementById('browseBtn');
  const btnContinue = document.getElementById('btnContinue');
  const btnNewSupplier = document.getElementById('btnNewSupplier');

  browseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    handleFiles(fileInput.files);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(evt => {
    dropzone.addEventListener(evt, e => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach(evt => {
    dropzone.addEventListener(evt, e => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
    });
  });

  dropzone.addEventListener('drop', e => {
    if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  });

  btnContinue.addEventListener('click', continueToScoring);

  if (btnNewSupplier) {
    btnNewSupplier.addEventListener('click', () => {
      resetLanding();
      showLanding();
    });
  }

  renderUploadList();
  updateContinueState();
});
