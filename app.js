// ===== PERSISTENCE (localStorage) =====
const STORAGE_KEY = 'outreachbot_state';

function saveState() {
  try {
    const toSave = {
      contacts:         state.contacts,
      queue:            state.queue,
      inbox:            state.inbox,
      followups:        state.followups.map(fu => ({
                          ...fu,
                          followupDate: fu.followupDate instanceof Date
                            ? fu.followupDate.toISOString()
                            : fu.followupDate,
                        })),
      logs:             state.logs,
      template:         state.template,
      followupTemplate: state.followupTemplate,
      followupDays:     state.followupDays,
      followupDelayMs:  state.followupDelayMs,
      followupDelayUnit: state.followupDelayUnit,
      followupDelayValue: state.followupDelayValue,
      channels:         state.channels,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch(e) {
    console.warn('Could not save state:', e);
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    // Rehydrate followupDate strings → Date objects
    if (saved.followups) {
      saved.followups = saved.followups.map(fu => ({
        ...fu,
        followupDate: new Date(fu.followupDate),
      }));
    }
    return saved;
  } catch(e) {
    console.warn('Could not load state:', e);
    return null;
  }
}

// ===== STATE =====
const _saved = loadState();
const state = {
  contacts:         _saved?.contacts         || [],
  queue:            _saved?.queue            || [],
  followups:        _saved?.followups        || [],
  logs:             _saved?.logs             || [],
  inbox:            _saved?.inbox            || [],   // CRM records
  template:         _saved?.template         || '',
  followupTemplate: _saved?.followupTemplate || '',
  followupDays:     _saved?.followupDays     ?? 4,      // legacy fallback
  followupDelayMs:  _saved?.followupDelayMs  ?? (60 * 60 * 1000), // default 1 hour
  followupDelayUnit: _saved?.followupDelayUnit ?? 'hours',
  followupDelayValue: _saved?.followupDelayValue ?? 1,
  channels:         _saved?.channels         || ['email'],
  sending: false,
  paused:  false,
  senderConfig: {
    sender_name:  'Vhits',
    company_name: 'Virtual Heights',
    website_name: 'Automation System',
    website_url:  'https://virtualheights.in',
    
  },
};

const API = 'http://localhost:8000';

// ===== CONNECTION STATUS =====
async function checkBackendHealth() {
  try {
    const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      setConnectionStatus(true, data);
    } else {
      setConnectionStatus(false);
    }
  } catch {
    setConnectionStatus(false);
  }
}

let _lastConnected = null; // track previous state to avoid redundant UI updates

function setConnectionStatus(connected, data = null) {
  const dot  = document.getElementById('conn-dot');
  const text = document.getElementById('conn-text');
  if (!dot || !text) return;

  // Only re-render if status actually changed
  if (_lastConnected === connected && !data) return;
  _lastConnected = connected;

  if (connected) {
    dot.className  = 'conn-dot connected';
    text.textContent = 'Backend connected';
    if (data) {
      const flags = [];
      if (data.twilio)  flags.push('Twilio ✓');
      if (data.smtp)    flags.push('SMTP ✓');
      if (data.ai)      flags.push('AI ✓');
      if (flags.length) text.textContent = `Connected · ${flags.join(' · ')}`;
    }
  } else {
    dot.className  = 'conn-dot disconnected';
    text.textContent = 'Backend offline — start: uvicorn main:app --reload --port 8000';
  }
}

// Check on load and every 60s (reduced from 15s to avoid log spam)
checkBackendHealth();
setInterval(checkBackendHealth, 60000);

// ===== LOAD SENDER CONFIG FROM BACKEND =====
async function loadSenderConfig() {
  try {
    const res = await fetch(`${API}/sender-config`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      state.senderConfig = { ...state.senderConfig, ...data };
      // Update template previews with fresh brand vars
      updatePreview && updatePreview();
      console.log('✅ Sender config loaded:', state.senderConfig);
    }
  } catch {
    // Backend offline — use defaults already in state.senderConfig
  }
}
loadSenderConfig();

// ===== TABS =====
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ===== FILE UPLOAD =====
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});
fileInput.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });

function handleFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'csv')       parseCSV(e.target.result);
    else if (ext === 'json') parseJSON(e.target.result);
    else showToast('Unsupported file type', 'error');
  };
  reader.readAsText(file);
}

// Proper CSV parser — handles quoted fields containing commas
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCSV(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) { showToast('CSV file has no data rows', 'error'); return; }
  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/"/g, ''));
  const data = lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => obj[h] = (vals[i] || '').replace(/"/g, ''));
    return obj;
  }).filter(r => r.name || r.email || r.phone);
  state.contacts = data;
  renderPreview(headers, data);
  saveState();
}

function parseJSON(text) {
  try {
    const data = JSON.parse(text);
    const arr = Array.isArray(data) ? data : data.contacts || [data];
    state.contacts = arr;
    const headers = arr.length > 0 ? Object.keys(arr[0]) : [];
    renderPreview(headers, arr);
    saveState();
  } catch { showToast('Invalid JSON file', 'error'); }
}

function renderPreview(headers, data) {
  const wrap  = document.getElementById('preview-wrap');
  const table = document.getElementById('preview-table');
  document.getElementById('preview-count').textContent = `(${data.length} contacts)`;
  table.querySelector('thead').innerHTML = `<tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>`;
  table.querySelector('tbody').innerHTML = data.slice(0, 10).map(row =>
    `<tr>${headers.map(h => `<td>${row[h] || '—'}</td>`).join('')}</tr>`
  ).join('');
  wrap.style.display = 'block';
  updateStats();
}

document.getElementById('load-to-queue').addEventListener('click', () => {
  state.queue = state.contacts.map((c, i) => ({ ...c, id: i, status: 'pending' }));
  renderQueue();
  updateStats();
  saveState();
  showToast(`${state.queue.length} contacts loaded to queue ✓`, 'success');
  switchTab('queue');
});

// ===== CHANNEL SELECTION =====
function refreshChannelCards() {
  document.querySelectorAll('.channel-card').forEach(card => {
    const cb = card.querySelector('input[type=checkbox]');
    if (cb.checked) {
      card.setAttribute('data-selected', 'true');
      card.style.background      = 'rgba(6,182,212,0.15)';
      card.style.borderColor     = 'var(--cyan-500)';
      card.style.boxShadow       = '0 0 14px rgba(6,182,212,0.25)';
      const lbl = card.querySelector('span:last-child');
      if (lbl) lbl.style.color = 'var(--cyan-400)';
    } else {
      card.removeAttribute('data-selected');
      card.style.background  = '';
      card.style.borderColor = '';
      card.style.boxShadow   = '';
      const lbl = card.querySelector('span:last-child');
      if (lbl) lbl.style.color = '';
    }
  });
  state.channels = [...document.querySelectorAll('.channel-card input:checked')]
    .map(i => i.value.toLowerCase());
  saveState();
}

document.querySelectorAll('.channel-card').forEach(card => {
  card.addEventListener('click', () => {
    const cb = card.querySelector('input[type=checkbox]');
    cb.checked = !cb.checked;
    refreshChannelCards();
  });
});

// Init on load
refreshChannelCards();

// Restore delay fields from saved state
(function restoreDelayFields() {
  const valEl  = document.getElementById('followup-delay-value');
  const unitEl = document.getElementById('followup-delay-unit');
  if (valEl && state.followupDelayValue) valEl.value = state.followupDelayValue;
  if (unitEl && state.followupDelayUnit) unitEl.value = state.followupDelayUnit;
})();

// ===== TEMPLATE =====
const msgTpl      = document.getElementById('msg-template');
const fuTpl       = document.getElementById('followup-template');
const msgPreview  = document.getElementById('msg-preview');

// Which template is currently being previewed: 'main' or 'followup'
let previewMode = 'main';

function updatePreview() {
  const src   = previewMode === 'main' ? msgTpl.value : fuTpl.value;
  const label = previewMode === 'main' ? '📝 Main Template' : '🔁 Follow-up Template';
  const preview = src
    .replace(/{{name}}/g,  'John Doe')
    .replace(/{{email}}/g, 'john@example.com')
    .replace(/{{phone}}/g, '+919876543210');

  msgPreview.textContent = preview || 'Start typing in a template to see preview...';

  // Update header label
  const labelEl = document.getElementById('preview-label');
  if (labelEl) labelEl.textContent = `LIVE PREVIEW — ${label}`;

  // Highlight the active pill (Main / Follow-up)
  const pillMain = document.getElementById('preview-hint-main');
  const pillFu   = document.getElementById('preview-hint-fu');
  if (pillMain && pillFu) {
    const activeStyle   = 'font-size:10px;padding:2px 8px;border-radius:20px;background:rgba(6,182,212,0.15);border:1px solid rgba(6,182,212,0.3);color:var(--cyan-400);font-family:var(--font-mono);';
    const inactiveStyle = 'font-size:10px;padding:2px 8px;border-radius:20px;background:var(--surface-2);border:1px solid var(--border);color:var(--text-muted);font-family:var(--font-mono);';
    pillMain.style.cssText = previewMode === 'main'     ? activeStyle : inactiveStyle;
    pillFu.style.cssText   = previewMode === 'followup' ? activeStyle : inactiveStyle;
  }
}

let templateDebounceTimer = null;

// Main template → update preview when main is focused/typing
msgTpl.addEventListener('focus', () => { previewMode = 'main'; updatePreview(); });
msgTpl.addEventListener('click', () => { previewMode = 'main'; updatePreview(); });
msgTpl.addEventListener('input', () => {
  previewMode = 'main';
  clearTimeout(templateDebounceTimer);
  templateDebounceTimer = setTimeout(updatePreview, 200);
});

// Follow-up template → switch preview when clicked/focused
fuTpl.addEventListener('focus', () => { previewMode = 'followup'; updatePreview(); });
fuTpl.addEventListener('click', () => { previewMode = 'followup'; updatePreview(); });
fuTpl.addEventListener('mousedown', () => { previewMode = 'followup'; });
fuTpl.addEventListener('input', () => {
  previewMode = 'followup';
  clearTimeout(templateDebounceTimer);
  templateDebounceTimer = setTimeout(updatePreview, 200);
});

document.getElementById('save-template').addEventListener('click', () => {
  state.template         = msgTpl.value;
  state.followupTemplate = fuTpl.value;

  // Read new delay value + unit
  const delayVal  = parseInt(document.getElementById('followup-delay-value')?.value) || 1;
  const delayUnit = document.getElementById('followup-delay-unit')?.value || 'hours';
  const unitMs    = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
  state.followupDelayValue = delayVal;
  state.followupDelayUnit  = delayUnit;
  state.followupDelayMs    = delayVal * (unitMs[delayUnit] || 3_600_000);
  state.followupDays       = delayUnit === 'days' ? delayVal : 0; // legacy compat

  // Both templates are optional individually — at least one must be filled
  if (!state.template && !state.followupTemplate) {
    showToast('Please write at least a Main or Follow-up template!', 'error');
    return;
  }

  saveState();

  const mainStatus   = state.template         ? '✅ Main set'      : '⚠️ Main empty (will skip initial send)';
  const followStatus = state.followupTemplate  ? '✅ Follow-up set' : '⚠️ Follow-up empty (will reuse Main)';
  showToast(`Saved! ${mainStatus} · ${followStatus}`, 'success');
  updatePreview();
});

// ===== MANUAL SEND PILLS =====
function refreshManualPills() {
  document.querySelectorAll('.manual-pill').forEach(pill => {
    const cb = pill.querySelector('input[type=checkbox]');
    if (cb.checked) {
      pill.classList.add('active');
    } else {
      pill.classList.remove('active');
    }
  });
}

document.querySelectorAll('.manual-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    const cb = pill.querySelector('input[type=checkbox]');
    cb.checked = !cb.checked;
    refreshManualPills();
  });
});

// Init manual pills on load
refreshManualPills();

// ===== MANUAL SEND FORM =====
const manualForm = document.getElementById('manual-send-form');
if (manualForm) {
  document.getElementById('btn-manual-send').addEventListener('click', async () => {
    const name     = document.getElementById('m-name').value.trim();
    const phone    = document.getElementById('m-phone').value.trim();
    const whatsapp = document.getElementById('m-whatsapp').value.trim();
    const email    = document.getElementById('m-email').value.trim();
    const message  = document.getElementById('m-message').value.trim();
    const channels = [...document.querySelectorAll('.manual-channel:checked')].map(c => c.value.toLowerCase());

    if (!message)          { showToast('Enter a message', 'error'); return; }
    if (!channels.length)  { showToast('Select at least one channel', 'error'); return; }

    const payload = {
      contact: { name, phone, whatsapp: whatsapp || phone, email, linkedin: '' },
      message,
      channels,
      isFollowup: false,
    };

    const btn = document.getElementById('btn-manual-send');
    btn.textContent = 'Sending...';
    btn.disabled    = true;

    try {
      const res  = await fetch(`${API}/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      renderManualResult(data.results || {});
      addLog(`Manual send to ${name || phone}`, 'success', channels.join(', '));
    } catch (err) {
      showToast('Send failed: ' + err.message, 'error');
      addLog(`Manual send failed: ${err.message}`, 'error');
    } finally {
      btn.textContent = '🚀 Send Now';
      btn.disabled    = false;
    }
  });
}

function renderManualResult(results) {
  const box = document.getElementById('manual-result');
  if (!box) return;
  box.innerHTML = Object.entries(results).map(([ch, r]) => {
    const ok    = r && r.success !== false;
    const icon  = ok ? '✅' : '❌';
    const label = ok ? (r.note || `Sent (${r.sid || r.to || ''})`) : (r.error || 'Failed');
    return `<div class="result-row ${ok ? 'ok' : 'fail'}">${icon} <strong>${ch}</strong>: ${label}</div>`;
  }).join('');
  box.style.display = 'block';
}

// ===== QUEUE =====
function renderQueue() {
  const list = document.getElementById('queue-list');
  if (!state.queue.length) {
    list.innerHTML = '<div class="empty-state">No contacts in queue yet. Upload a document first.</div>';
    return;
  }
  list.innerHTML = state.queue.map(item => `
    <div class="queue-item ${item.status}" id="qi-${item.id}">
      <div class="qi-avatar">${(item.name || '?')[0].toUpperCase()}</div>
      <div class="qi-info">
        <div class="qi-name">${item.name || 'Unknown'}</div>
        <div class="qi-detail">
          ${item.email ? `📧 ${item.email}` : ''}
          ${item.phone ? `📱 ${item.phone}` : ''}
          ${item.whatsapp && item.whatsapp !== item.phone ? `💬 ${item.whatsapp}` : ''}
        </div>
        <div class="qi-channels">${state.channels.map(ch => `<span class="ch-tag">${channelIcon(ch)} ${ch}</span>`).join('')}</div>
      </div>
      <div class="qi-status">${statusIcon(item.status)}</div>
      <div class="qi-actions">
        ${item.status === 'pending' ? `<button class="qi-btn send-now" onclick="sendSingle(${item.id})">Send Now</button>` : ''}
        <button class="qi-btn" onclick="removeFromQueue(${item.id})">Remove</button>
      </div>
    </div>
  `).join('');
  updateProgress();
}

function channelIcon(ch) {
  return { email: '📧', linkedin: '💼', sms: '💬', whatsapp: '📱', phone: '📞' }[ch.toLowerCase()] || '📨';
}
function statusIcon(s) {
  return { pending: '⏳', sending: '⚡', done: '✅', failed: '❌', partial: '⚠️' }[s] || '⏳';
}

function updateProgress() {
  const done  = state.queue.filter(q => q.status === 'done' || q.status === 'partial').length;
  const total = state.queue.length;
  document.getElementById('progress-fill').style.width = total ? `${(done / total) * 100}%` : '0%';
  document.getElementById('progress-label').textContent = `${done} / ${total}`;
  updateStats();
}

function updateStats() {
  document.getElementById('stat-total').textContent   = state.contacts.length;
  document.getElementById('stat-sent').textContent    = state.queue.filter(q => q.status === 'done' || q.status === 'partial').length;
  document.getElementById('stat-pending').textContent = state.queue.filter(q => q.status === 'pending').length;
}

// ===== SEND ALL =====
document.getElementById('btn-send-all').addEventListener('click', async () => {
  if (state.sending) return;
  if (!state.template && !state.followupTemplate) {
    showToast('Please write and save a template first!', 'error');
    switchTab('compose');
    return;
  }
  if (!state.template) {
    showToast('⚠️ Main template is empty — only follow-ups will send', 'error');
  }
  if (!state.channels.length) { showToast('Select at least one channel', 'error'); return; }
  state.sending = true;
  state.paused  = false;
  const pending = state.queue.filter(q => q.status === 'pending');
  for (const item of pending) {
    if (state.paused) break;
    await sendContact(item);
    await sleep(800);
  }
  state.sending = false;
  showToast('All messages processed!', 'success');
});

document.getElementById('btn-pause').addEventListener('click', () => {
  state.paused = true; state.sending = false;
  showToast('Sending paused');
});

document.getElementById('btn-clear-queue').addEventListener('click', () => {
  state.queue = []; renderQueue(); updateStats(); saveState();
});

async function sendSingle(id) {
  const item = state.queue.find(q => q.id === id);
  if (item) await sendContact(item);
}

async function sendContact(item) {
  item.status = 'sending';
  renderQueueItem(item);

  try {
    const msg     = buildMessage(state.template, item);
    // Normalize channels to lowercase before sending
    const channels = state.channels.map(c => c.toLowerCase());
    const payload  = { contact: item, message: msg, channels };

    const res = await fetch(`${API}/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(err => {
      addLog(`✗ Network error sending to ${item.name || item.email || item.phone}: ${err.message}`, 'error');
      return null;
    });

    if (res && res.ok) {
      const data    = await res.json();
      const results = data.results || {};

      const channelEntries  = Object.entries(results);
      const successChannels = channelEntries.filter(([, r]) => r && r.success !== false).map(([ch]) => ch);
      const failedChannels  = channelEntries.filter(([, r]) => r && r.success === false);

      if (failedChannels.length === 0) {
        item.status = 'done';
        const followupDate = new Date(Date.now() + state.followupDelayMs);
        state.followups.push({ ...item, followupDate, followupSent: false,
          scheduledAt: new Date().toISOString(),
          reply: null,
          delayLabel: `${state.followupDelayValue} ${state.followupDelayUnit}`,
        });
        addLog(`✓ Sent to ${item.name || item.email || item.phone} via ${successChannels.join(', ')}`, 'success', successChannels.join(', '));
        // Create / update CRM inbox record
        upsertInboxRecord(item, {
          type: 'sent', text: buildMessage(state.template, item),
          channels: successChannels, time: new Date().toISOString(),
        });
        renderFollowups();
      } else if (successChannels.length > 0) {
        item.status = 'partial';
        const failDetails = failedChannels.map(([ch, r]) => `${ch}: ${r.error || 'Failed'}`).join('; ');
        addLog(`⚠️ Partial: ${item.name || item.phone} — OK: ${successChannels.join(', ')} | Failed: ${failDetails}`, 'warn');
        const followupDate = new Date(Date.now() + state.followupDelayMs);
        state.followups.push({ ...item, followupDate, followupSent: false,
          scheduledAt: new Date().toISOString(),
          reply: null,
          delayLabel: `${state.followupDelayValue} ${state.followupDelayUnit}`,
        });
        renderFollowups();
      } else {
        item.status = 'failed';
        const failDetails = failedChannels.map(([ch, r]) => `${ch}: ${r.error || 'Failed'}`).join('; ');
        addLog(`✗ Failed to send to ${item.name || item.phone}: ${failDetails}`, 'error');
      }
    } else {
      item.status = 'failed';
      addLog(`✗ Server error sending to ${item.name || item.email || item.phone}`, 'error');
    }
  } catch (err) {
    item.status = 'failed';
    addLog(`✗ Error: ${err.message}`, 'error');
  }

  renderQueueItem(item);
  updateProgress();
  saveState();
}

function renderQueueItem(item) {
  const el = document.getElementById(`qi-${item.id}`);
  if (el) {
    el.className = `queue-item ${item.status}`;
    el.querySelector('.qi-status').textContent = statusIcon(item.status);
  }
}

function buildMessage(template, contact) {
  const sc = state.senderConfig;
  return template
    .replace(/{{name}}/g,    contact.name    || 'there')
    .replace(/{{email}}/g,   contact.email   || '')
    .replace(/{{phone}}/g,   contact.phone   || '')
    .replace(/{{sender}}/g,  sc.sender_name  || 'Vhits')
    .replace(/{{company}}/g, sc.company_name || 'Virtual Heights')
    .replace(/{{website}}/g, sc.website_name || 'Automation System')
    .replace(/{{url}}/g,     sc.website_url  || 'https://virtualheights.in');
}

function removeFromQueue(id) {
  state.queue = state.queue.filter(q => q.id !== id);
  renderQueue(); updateStats(); saveState();
}

// ===== FOLLOW-UPS =====
function formatTimeLeft(ms) {
  if (ms <= 0) return { label: 'DUE NOW', cls: 'overdue' };
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60)  return { label: `${totalSec}s`, cls: 'soon' };
  const mins = Math.floor(totalSec / 60);
  if (mins < 60) return { label: `${mins}m ${totalSec % 60}s`, cls: mins < 5 ? 'soon' : 'ok' };
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return { label: `${hrs}h ${mins % 60}m`, cls: 'ok' };
  const days = Math.floor(hrs / 24);
  return { label: `${days}d ${hrs % 24}h`, cls: 'ok' };
}

// ===== HTML ESCAPE HELPER =====
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ===== FOLLOW-UP REPLY INBOX =====
// Each follow-up stores fu.replies = [ { channel, text, date } ]
// Channels: email | whatsapp | sms | linkedin

const REPLY_CHANNELS = [
  { key: 'email',    icon: '📧', label: 'Email' },
  { key: 'whatsapp', icon: '📱', label: 'WhatsApp' },
  { key: 'sms',      icon: '💬', label: 'SMS' },
  { key: 'linkedin', icon: '💼', label: 'LinkedIn' },
];

// Track which channel tab is open per follow-up card
const _fuReplyTab = {};

function getFuReplyTab(i) {
  return _fuReplyTab[i] || 'email';
}

function setFuReplyTab(i, ch) {
  _fuReplyTab[i] = ch;
  // Re-render just the reply section without full re-render
  const replyEl = document.getElementById(`fu-reply-section-${i}`);
  if (replyEl) replyEl.outerHTML = buildReplySection(i);
}

function buildReplySection(i) {
  const fu = state.followups[i];
  if (!fu) return '';
  const replies = fu.replies || [];
  const activeTab = getFuReplyTab(i);
  const chReplies = replies.filter(r => r.channel === activeTab);

  const tabsHtml = REPLY_CHANNELS.map(ch => `
    <button onclick="setFuReplyTab(${i},'${ch.key}')"
      style="padding:4px 10px;border-radius:20px;border:1px solid ${activeTab===ch.key ? 'var(--cyan-500)' : 'var(--border)'};
             background:${activeTab===ch.key ? 'rgba(6,182,212,0.15)' : 'transparent'};
             color:${activeTab===ch.key ? 'var(--cyan-400)' : 'var(--text-muted)'};
             font-family:var(--font-mono);font-size:10px;cursor:pointer;transition:all .15s;white-space:nowrap;">
      ${ch.icon} ${ch.label}${replies.filter(r=>r.channel===ch.key).length ? ` <span style="background:var(--cyan-500);color:#000;border-radius:10px;padding:0 5px;font-size:9px;margin-left:2px;">${replies.filter(r=>r.channel===ch.key).length}</span>` : ''}
    </button>`).join('');

  const repliesHtml = chReplies.length
    ? chReplies.map((r, ri) => `
        <div style="background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.2);border-radius:6px;padding:8px 12px;position:relative;">
          <div style="font-size:12px;color:var(--text-primary);white-space:pre-wrap;">${escapeHtml(r.text)}</div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px;">
            <span style="font-size:10px;font-family:var(--font-mono);color:var(--text-muted);">📅 ${new Date(r.date).toLocaleString()} · via ${r.channel.toUpperCase()}${r.auto ? ' <span style="background:rgba(6,182,212,0.2);color:var(--cyan-400);border-radius:4px;padding:0 5px;font-size:9px;margin-left:4px;">⚡ Auto</span>' : ''}</span>
            <button onclick="deleteFuReply(${i},${ri})"
              style="padding:2px 8px;border-radius:4px;border:1px solid rgba(244,63,94,0.3);background:rgba(244,63,94,0.08);
                     color:#fda4af;font-size:10px;cursor:pointer;font-family:var(--font-mono);">✕</button>
          </div>
        </div>`).join('')
    : `<div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);padding:6px 0;">No ${activeTab} replies yet.</div>`;

  return `<div id="fu-reply-section-${i}" style="border-top:1px solid var(--border);padding-top:10px;">
    <!-- Channel tabs -->
    <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px;">${tabsHtml}</div>
    <!-- Saved replies -->
    <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px;">${repliesHtml}</div>
    <!-- Input row -->
    <div style="display:flex;gap:6px;align-items:flex-end;">
      <textarea id="fu-reply-input-${i}"
        placeholder="Paste reply received via ${activeTab}..."
        rows="2"
        style="flex:1;background:var(--surface-2);border:1px solid var(--border);color:var(--text-primary);
               font-family:var(--font-ui);font-size:12px;padding:7px 10px;border-radius:6px;
               resize:none;outline:none;"></textarea>
      <button onclick="saveFuReply(${i},'${activeTab}')"
        style="padding:7px 14px;border-radius:6px;border:none;cursor:pointer;font-size:12px;font-weight:600;
               font-family:var(--font-ui);white-space:nowrap;align-self:stretch;
               background:linear-gradient(135deg,var(--cyan-500),#0891b2);
               color:#fff;box-shadow:0 2px 8px rgba(6,182,212,0.3);transition:all .15s;">
        💾 Save Reply
      </button>
    </div>
  </div>`;
}

function saveFuReply(i, channel) {
  const input = document.getElementById(`fu-reply-input-${i}`);
  if (!input) return;
  const val = input.value.trim();
  if (!val) { showToast('Type the reply first', 'error'); return; }

  const fu = state.followups[i];
  if (!fu) return;
  if (!fu.replies) fu.replies = [];

  const entry = { channel, text: val, date: new Date().toISOString() };
  fu.replies.push(entry);

  // Also log in CRM inbox
  upsertInboxRecord(fu, {
    type: 'reply',
    title: `Reply received via ${channel.toUpperCase()}`,
    text: val,
    time: entry.date,
    channels: [channel],
  });

  addLog(`💬 ${channel.toUpperCase()} reply from ${fu.name || fu.email || 'contact'}: "${val.slice(0,60)}…"`, 'success', channel);
  saveState();
  showToast(`${channel.toUpperCase()} reply saved ✓`, 'success');

  // Re-render the reply section only
  const replyEl = document.getElementById(`fu-reply-section-${i}`);
  if (replyEl) replyEl.outerHTML = buildReplySection(i);
}

function deleteFuReply(i, ri) {
  const fu = state.followups[i];
  if (!fu || !fu.replies) return;
  fu.replies.splice(ri, 1);
  saveState();
  const replyEl = document.getElementById(`fu-reply-section-${i}`);
  if (replyEl) replyEl.outerHTML = buildReplySection(i);
  showToast('Reply removed', 'success');
}

// ===== AUTO-FETCH REPLIES FROM BACKEND =====
// Polls /fetch-replies every 60s (only when follow-ups exist)
// and auto-stores matched replies into the correct follow-up card.

let _lastFetchTime = Date.now() - (60 * 60 * 1000); // start by fetching last 60 min
let _fetchPaused   = false; // paused when backend was offline

async function autoFetchReplies() {
  // Skip entirely if no follow-ups to match against
  if (!state.followups.length) return;
  // Skip if manually paused after a connection failure
  if (_fetchPaused) return;

  const sinceMinutes = Math.min(
    Math.ceil((Date.now() - _lastFetchTime) / 60000) + 2,
    1440  // cap at 24h to avoid huge IMAP scans
  );

  // Build contacts list from current follow-ups (for matching on backend)
  const contacts = state.followups.map(fu => ({
    name:     fu.name     || '',
    email:    fu.email    || '',
    phone:    fu.phone    || fu.whatsapp || '',
    whatsapp: fu.whatsapp || fu.phone    || '',
  }));

  try {
    const res = await fetch(`${API}/fetch-replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contacts, since_minutes: sinceMinutes }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;
    const data = await res.json();
    const incoming = data.replies || [];
    if (!incoming.length) {
      _lastFetchTime = Date.now();
      return;
    }

    let newCount = 0;

    incoming.forEach(reply => {
      // Find which follow-up this reply belongs to
      const fuIdx = state.followups.findIndex(fu => {
        if (reply.channel === 'email' && reply.matched_email) {
          return (fu.email || '').toLowerCase() === reply.matched_email.toLowerCase();
        }
        if ((reply.channel === 'sms' || reply.channel === 'whatsapp') && reply.matched_phone) {
          const fuPhone = (fu.phone || fu.whatsapp || '').replace(/\D/g, '');
          const rPhone  = reply.matched_phone.replace(/\D/g, '');
          return fuPhone && rPhone && (fuPhone.endsWith(rPhone) || rPhone.endsWith(fuPhone));
        }
        return false;
      });

      if (fuIdx === -1) return;

      const fu = state.followups[fuIdx];
      if (!fu.replies) fu.replies = [];

      // De-duplicate: skip if same text + channel already stored
      const isDupe = fu.replies.some(r =>
        r.channel === reply.channel &&
        r.text.trim().slice(0, 80) === reply.text.trim().slice(0, 80)
      );
      if (isDupe) return;

      const entry = {
        channel: reply.channel,
        text:    reply.text,
        date:    reply.date || new Date().toISOString(),
        auto:    true,
      };
      fu.replies.push(entry);
      newCount++;

      addLog(`📥 Auto-fetched ${reply.channel.toUpperCase()} reply from ${fu.name || fu.email || 'contact'}: "${reply.text.slice(0, 50)}…"`, 'success', reply.channel);

      upsertInboxRecord(fu, {
        type:     'reply',
        title:    `Auto-fetched reply via ${reply.channel.toUpperCase()}`,
        text:     reply.text,
        time:     entry.date,
        channels: [reply.channel],
      });
    });

    if (newCount > 0) {
      saveState();
      renderFollowups();
      showToast(`📥 ${newCount} new repl${newCount > 1 ? 'ies' : 'y'} auto-fetched!`, 'success');
    }

    _lastFetchTime = Date.now();
  } catch {
    // Backend offline or fetch timed out — silently skip, don't spam retries
  }
}

// Poll every 60 seconds (only fires if follow-ups exist)
setInterval(autoFetchReplies, 60000);
// Fetch once on load — delayed until after backend health check completes
setTimeout(autoFetchReplies, 5000);

// Manual "Fetch Replies Now" button
document.addEventListener('DOMContentLoaded', () => {
  const fetchBtn = document.getElementById('btn-fetch-replies');
  if (fetchBtn) {
    fetchBtn.addEventListener('click', async () => {
      fetchBtn.textContent = '⏳ Fetching…';
      fetchBtn.disabled = true;
      _lastFetchTime = Date.now() - (24 * 60 * 60 * 1000); // look back 24h on manual fetch
      await autoFetchReplies();
      fetchBtn.textContent = '📥 Fetch Replies Now';
      fetchBtn.disabled = false;
    });
  }
});

// ── Reply indicator badge on Follow-ups nav item ──────────────────────────
function updateFollowupNavBadge() {
  const totalUnread = state.followups.reduce((sum, fu) => sum + (fu.replies || []).length, 0);
  const navBtn = document.querySelector('.nav-btn[data-tab="followup"]');
  if (!navBtn) return;
  let badge = navBtn.querySelector('.nav-reply-badge');
  if (totalUnread > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'nav-reply-badge';
      badge.style.cssText = 'margin-left:auto;background:var(--cyan-500);color:#000;border-radius:10px;padding:1px 7px;font-size:10px;font-weight:700;font-family:var(--font-mono);';
      navBtn.appendChild(badge);
    }
    badge.textContent = totalUnread;
  } else if (badge) {
    badge.remove();
  }
}

function renderFollowups() {
  const list = document.getElementById('followup-list');
  if (!state.followups.length) {
    list.innerHTML = '<div class="empty-state">No follow-ups scheduled yet.<br/>They appear here after messages are sent.</div>';
    return;
  }
  const now = Date.now();
  list.innerHTML = state.followups.map((fu, i) => {
    const msLeft = fu.followupDate - now;
    const { label: timeLabel } = formatTimeLeft(msLeft);
    const scheduledStr = new Date(fu.followupDate).toLocaleString();
    const sentAt       = fu.scheduledAt ? new Date(fu.scheduledAt).toLocaleString() : '—';
    const fuSentAt     = fu.followupSentAt ? new Date(fu.followupSentAt).toLocaleString() : null;
    const overdue      = msLeft <= 0;
    const totalReplies = (fu.replies || []).length;

    // Status badge
    let statusBadge;
    if (fu.followupSent) {
      statusBadge = `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:3px 10px;border-radius:20px;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.3);color:#6ee7b7;font-family:var(--font-mono);">✓ Follow-up Sent</span>`;
    } else if (overdue) {
      statusBadge = `<span id="fu-countdown-${i}" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:3px 10px;border-radius:20px;background:rgba(244,63,94,0.12);border:1px solid rgba(244,63,94,0.35);color:#fda4af;font-family:var(--font-mono);font-weight:700;">🔔 DUE NOW</span>`;
    } else {
      statusBadge = `<span id="fu-countdown-${i}" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:3px 10px;border-radius:20px;background:rgba(6,182,212,0.1);border:1px solid rgba(6,182,212,0.25);color:var(--cyan-400);font-family:var(--font-mono);font-weight:700;">⏱ ${timeLabel}</span>`;
    }

    // Follow-up message preview
    const fuMsg = buildMessage(
      state.followupTemplate || state.template ||
      'Hi {{name}},\n\nI\'m checking back in to see if you\'ve had a chance to consider my previous note.\n\nWarm regards,\nVhits\nVirtual Heights | Automation AI\nhttps://virtualheights.in',
      fu
    );

    return `
    <div id="fu-item-${i}" style="border-radius:var(--radius-md);background:var(--surface);border:1px solid ${fu.followupSent ? 'rgba(16,185,129,0.25)' : overdue ? 'rgba(244,63,94,0.25)' : 'var(--border)'};margin-bottom:10px;overflow:hidden;transition:border-color .18s;">

      <!-- ── TOP BAR: avatar + info + status + action buttons ── -->
      <div style="display:flex;align-items:flex-start;gap:12px;padding:14px 16px;">

        <!-- Avatar / status icon -->
        <div style="width:42px;height:42px;border-radius:10px;flex-shrink:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;
                    background:${fu.followupSent ? 'rgba(16,185,129,0.12)' : overdue ? 'rgba(244,63,94,0.12)' : 'rgba(6,182,212,0.1)'};
                    border:1px solid ${fu.followupSent ? 'rgba(16,185,129,0.3)' : overdue ? 'rgba(244,63,94,0.35)' : 'rgba(6,182,212,0.25)'};">
          <span style="font-size:16px;">${fu.followupSent ? '✅' : overdue ? '🔔' : '⏱'}</span>
          <span style="font-size:8px;font-family:var(--font-mono);color:${fu.followupSent ? '#6ee7b7' : overdue ? '#fda4af' : 'var(--cyan-400)'};text-transform:uppercase;letter-spacing:.4px;">${fu.followupSent ? 'sent' : overdue ? 'due' : 'wait'}</span>
        </div>

        <!-- Info block -->
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:14px;color:var(--text-primary);margin-bottom:3px;">
            ${escapeHtml(fu.name || 'Unknown')}
            ${totalReplies ? `<span style="margin-left:8px;font-size:10px;padding:1px 7px;border-radius:10px;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.3);color:#6ee7b7;font-family:var(--font-mono);">💬 ${totalReplies} repl${totalReplies>1?'ies':'y'}</span>` : ''}
          </div>
          <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);display:flex;flex-wrap:wrap;gap:8px;">
            ${fu.email ? `<span>📧 ${escapeHtml(fu.email)}</span>` : ''}
            ${fu.phone ? `<span>📱 ${escapeHtml(fu.phone)}</span>` : ''}
          </div>
          <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);margin-top:4px;display:flex;flex-wrap:wrap;gap:10px;">
            <span>📤 Sent: <span style="color:var(--text-secondary);">${sentAt}</span></span>
            <span>📅 Due: <span style="color:${overdue && !fu.followupSent ? '#fda4af' : 'var(--text-secondary)'};">${scheduledStr}</span></span>
            ${fuSentAt ? `<span style="color:#6ee7b7;">✅ Follow-up sent: ${fuSentAt}</span>` : ''}
          </div>
          ${fu.delayLabel ? `<div style="font-size:10px;color:var(--text-muted);font-family:var(--font-mono);margin-top:3px;">⚙ Delay: ${fu.delayLabel}</div>` : ''}
        </div>

        <!-- Action buttons column -->
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;flex-shrink:0;">
          ${statusBadge}
          ${!fu.followupSent && overdue ? `
            <button onclick="sendFollowup(${i})"
              style="display:inline-flex;align-items:center;gap:5px;padding:6px 14px;border-radius:6px;border:none;cursor:pointer;
                     font-size:12px;font-weight:600;font-family:var(--font-ui);white-space:nowrap;
                     background:linear-gradient(135deg,var(--cyan-500),#0891b2);color:#fff;
                     box-shadow:0 2px 10px rgba(6,182,212,0.35);transition:all .15s;"
              onmouseover="this.style.transform='translateY(-1px)';this.style.boxShadow='0 4px 14px rgba(6,182,212,0.5)'"
              onmouseout="this.style.transform='';this.style.boxShadow='0 2px 10px rgba(6,182,212,0.35)'">
              🚀 Send Follow-up
            </button>` : ''}
          <button onclick="removeFollowup(${i})"
            style="display:inline-flex;align-items:center;gap:5px;padding:6px 14px;border-radius:6px;cursor:pointer;
                   font-size:12px;font-weight:600;font-family:var(--font-ui);white-space:nowrap;
                   background:rgba(244,63,94,0.08);border:1px solid rgba(244,63,94,0.3);color:#fda4af;
                   transition:all .15s;"
            onmouseover="this.style.background='rgba(244,63,94,0.18)';this.style.borderColor='rgba(244,63,94,0.55)'"
            onmouseout="this.style.background='rgba(244,63,94,0.08)';this.style.borderColor='rgba(244,63,94,0.3)'">
            🗑 Remove
          </button>
        </div>
      </div>

      <!-- ── FOLLOW-UP MESSAGE PREVIEW ── -->
      <div style="padding:0 16px 12px;">
        <div style="font-size:10px;font-family:var(--font-mono);color:var(--text-muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:5px;">
          ${fu.followupSent ? '📨 Follow-up message sent' : '📝 Follow-up message (to be sent)'}
        </div>
        <div style="font-size:12px;color:var(--text-secondary);white-space:pre-wrap;max-height:90px;overflow-y:auto;
                    background:${fu.followupSent ? 'rgba(16,185,129,0.05)' : 'rgba(6,182,212,0.03)'};
                    border:1px solid ${fu.followupSent ? 'rgba(16,185,129,0.18)' : 'var(--border)'};
                    padding:8px 12px;border-radius:6px;font-family:var(--font-mono);">${escapeHtml(fuMsg)}</div>
        ${fu.followupSentAt ? `<div style="font-size:10px;font-family:var(--font-mono);color:#6ee7b7;margin-top:4px;">Sent via: ${(fu.followupChannels||state.channels||[]).join(', ')}</div>` : ''}
      </div>

      <!-- ── REPLY INBOX (per-channel) ── -->
      <div style="padding:0 16px 14px;">
        <div style="font-size:10px;font-family:var(--font-mono);color:var(--text-muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;">
          💬 Replies Received
        </div>
        ${buildReplySection(i)}
      </div>

    </div>`;
  }).join('');
  updateFollowupNavBadge();
}

// ===== REMOVE FOLLOW-UP =====
function removeFollowup(i) {
  const fu = state.followups[i];
  if (!fu) return;
  if (!confirm(`Remove follow-up for ${fu.name || fu.email || 'this contact'}?`)) return;
  state.followups.splice(i, 1);
  renderFollowups();
  saveState();
  showToast('Follow-up removed ✓', 'success');
}

function saveReply(i) {
  // legacy shim — now handled by saveFuReply
  saveFuReply(i, getFuReplyTab(i));
}

function clearReply(i) {
  const fu = state.followups[i];
  if (!fu) return;
  fu.replies = [];
  fu.reply   = null;
  fu.replyAt = null;
  saveState();
  renderFollowups();
}

// ── Track which indices are currently being sent (prevent double-fire) ──
const _fuSending = new Set();

// ── Single master ticker: every second handles countdown + auto-send ─────
let _lastAutoCheck = 0;

setInterval(async () => {
  const now = Date.now();
  let needsRender = false;

  state.followups.forEach((fu, i) => {
    if (fu.followupSent) return;
    const msLeft = fu.followupDate - now;

    // Update countdown label in-place
    const el = document.getElementById(`fu-countdown-${i}`);
    if (el) {
      const { label } = formatTimeLeft(msLeft);
      el.textContent = label;
      if (msLeft <= 0) el.style.color = 'var(--rose-500)';
    }

    // If just crossed zero and not already being sent → re-render card
    if (msLeft <= 0 && !_fuSending.has(i)) needsRender = true;
  });

  if (needsRender) renderFollowups();

  // Auto-send check every 15 seconds
  if (now - _lastAutoCheck >= 15_000) {
    _lastAutoCheck = now;
    for (let i = 0; i < state.followups.length; i++) {
      const fu = state.followups[i];
      if (!fu.followupSent && !_fuSending.has(i) && (fu.followupDate - now) <= 0) {
        _fuSending.add(i);
        addLog(`⏰ Auto-sending follow-up to ${fu.name || fu.email || fu.phone}…`, 'info');
        sendFollowup(i).finally(() => _fuSending.delete(i));
      }
    }
  }
}, 1000);

// ── sendFollowup: tries backend; retries if backend offline ──────────────
async function sendFollowup(i) {
  const fu = state.followups[i];
  if (!fu) return;

  const defaultFollowup = `Hi {{name}},

I'm checking back in to see if you've had a chance to consider my previous note. Are you still interested in exploring this, or should I hold off?

We'd love to have a quick 10-minute conversation at your convenience.

Warm regards,
Vhits
Virtual Heights | Automation AI
https://virtualheights.in`;

  const msg = buildMessage(
    state.followupTemplate || state.template || defaultFollowup,
    fu
  );
  const channels = (state.channels || ['email']).map(c => c.toLowerCase());

  let backendOk = false;
  try {
    const res = await fetch(`${API}/send`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact: fu, message: msg, channels, isFollowup: true }),
      signal:  AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      const results = data.results || {};
      const anyOk = Object.values(results).some(r => r && r.success !== false);
      if (anyOk) {
        addLog(`✅ Follow-up sent to ${fu.name || fu.email || fu.phone} via ${channels.join(', ')}`, 'success', channels.join(', '));
      } else {
        const errs = Object.entries(results).map(([ch, r]) => `${ch}: ${r?.error || 'failed'}`).join('; ');
        addLog(`⚠️ Follow-up partial fail for ${fu.name || fu.phone}: ${errs}`, 'warn');
      }
      backendOk = true; // got a response — mark sent either way
    } else {
      addLog(`⚠️ Backend ${res.status} for ${fu.name || fu.phone} — marking sent`, 'warn');
      backendOk = true;
    }
  } catch (err) {
    // Backend offline or timed out — do NOT mark sent so it retries on next tick
    addLog(`⚠️ Backend offline — will retry follow-up for ${fu.name || fu.phone} in 15s`, 'warn');
    backendOk = false;
  }

  if (backendOk) {
    fu.followupSent     = true;
    fu.followupSentAt   = new Date().toISOString();
    fu.followupMessage  = msg;          // ✅ store what was sent
    fu.followupChannels = channels;     // ✅ store via which channels
    if (typeof upsertInboxRecord === 'function') {
      upsertInboxRecord(fu, {
        type: 'followup', title: '🔁 Follow-up sent',
        text: msg, time: fu.followupSentAt, channels,
      });
    }
    renderFollowups();
    saveState();
    showToast(`🔁 Follow-up sent to ${fu.name || fu.phone || fu.email} ✓`, 'success');
  } else {
    renderFollowups();
  }
}


// ===== LOGS =====
function addLog(msg, type = 'info', channel = '') {
  const entry = { msg, type, channel, time: new Date().toLocaleTimeString() };
  state.logs.unshift(entry);
  if (state.logs.length > 200) state.logs = state.logs.slice(0, 200); // cap log size
  renderLogs();
  saveState();
}

function renderLogs() {
  const list = document.getElementById('log-list');
  if (!state.logs.length) { list.innerHTML = '<div class="empty-state">No activity yet.</div>'; return; }
  const icons = { success: '✅', error: '❌', info: '💡', warn: '⚠️' };
  list.innerHTML = state.logs.slice(0, 100).map(l => `
    <div class="log-entry ${l.type}">
      <span class="log-time">${l.time}</span>
      <span class="log-icon">${icons[l.type] || '•'}</span>
      <span class="log-msg">${l.msg}</span>
      ${l.channel ? `<span class="log-channel">${l.channel}</span>` : ''}
    </div>
  `).join('');
}

document.getElementById('clear-logs').addEventListener('click', () => { state.logs = []; renderLogs(); saveState(); });
document.getElementById('export-logs').addEventListener('click', () => {
  const csv = 'time,type,message,channel\n' +
    state.logs.map(l => `"${l.time}","${l.type}","${l.msg}","${l.channel}"`).join('\n');
  downloadText('activity-logs.csv', csv);
});

// ===== CHAT BOT =====
document.getElementById('chat-fab').addEventListener('click', () => {
  document.getElementById('chat-panel').classList.toggle('open');
});
document.getElementById('chat-close').addEventListener('click', () => {
  document.getElementById('chat-panel').classList.remove('open');
});

const chatInput = document.getElementById('chat-input');
document.getElementById('chat-send').addEventListener('click', handleChat);
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleChat(); });

async function handleChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  appendChat(text, 'user');
  chatInput.value = '';

  try {
    const res = await fetch(`${API}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message:  text,
        contacts: state.contacts.length,
        sent:     state.queue.filter(q => q.status === 'done' || q.status === 'partial').length,
      }),
    }).catch(() => null);

    if (res && res.ok) {
      const data = await res.json();
      if (data.action) handleAction(data);
      else appendChat(data.response || data.message || 'Done!', 'bot');
    } else {
      appendChat(localChatParse(text), 'bot');
    }
  } catch {
    appendChat(localChatParse(text), 'bot');
  }
}

function localChatParse(text) {
  const t = text.toLowerCase();
  if (t.includes('send all') || t.includes('start sending')) {
    document.getElementById('btn-send-all').click();
    return '▶ Starting to send all queued messages!';
  }
  if (t.includes('pause'))   { document.getElementById('btn-pause').click(); return '⏸ Sending paused.'; }
  if (t.includes('how many') && t.includes('contact')) return `📊 ${state.contacts.length} contacts loaded, ${state.queue.filter(q => q.status === 'done').length} sent.`;
  if (t.includes('follow'))  return `🔁 ${state.followups.length} follow-ups scheduled.`;
  if (t.includes('upload') || t.includes('file'))       { switchTab('upload');  return '📂 Opening upload tab!'; }
  if (t.includes('queue'))                               { switchTab('queue');   return '📋 Opening send queue!'; }
  if (t.includes('template') || t.includes('compose'))  { switchTab('compose'); return '✉️ Opening compose tab!'; }
  if (t.includes('log'))                                 { switchTab('logs');    return '📊 Opening logs!'; }
  if (t.includes('sms'))     return '💬 SMS is supported! Select "SMS" in the channel picker and ensure TWILIO_FROM is set in your .env file.';
  if (t.includes('clear queue')) { document.getElementById('btn-clear-queue').click(); return '🗑 Queue cleared.'; }
  return `I can help you send messages, check queue status, manage follow-ups, or navigate the app. What would you like to do?`;
}

function handleAction(data) {
  const { action, parameters } = data;
  if (action === 'schedule_meeting') {
    appendChat(`📅 Meeting scheduled for ${parameters.name} on ${parameters.date} at ${parameters.time}`, 'bot');
    addLog(`Meeting scheduled: ${parameters.name} @ ${parameters.date} ${parameters.time}`, 'info');
  } else if (action === 'send_email') {
    appendChat(`📧 Email queued to ${parameters.to}`, 'bot');
    addLog(`Email sent to ${parameters.to}`, 'success', 'email');
  } else if (action === 'create_lead') {
    appendChat(`💾 Lead saved: ${parameters.name} (${parameters.email})`, 'bot');
    addLog(`Lead created: ${parameters.email}`, 'info');
  }
}

function appendChat(msg, role) {
  const msgs = document.getElementById('chat-messages');
  const div  = document.createElement('div');
  div.className   = `chat-msg ${role}`;
  div.textContent = msg;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

// ===== UTILITIES =====
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function switchTab(tab) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
}

function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className   = `toast show ${type}`;
  setTimeout(() => toast.className = 'toast', 2800);
}

function downloadText(filename, text) {
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = filename;
  a.click();
}


// ===== INIT — restore persisted state =====
(function restoreUI() {
  // Restore template textareas
  if (state.template)         msgTpl.value = state.template;
  if (state.followupTemplate) fuTpl.value  = state.followupTemplate;
  // delay fields restored above via restoreDelayFields()

  // Restore channel checkboxes
  if (state.channels && state.channels.length) {
    document.querySelectorAll('.channel-card input[type=checkbox]').forEach(cb => {
      cb.checked = state.channels.includes(cb.value.toLowerCase());
    });
    refreshChannelCards();
  }

  // Restore contact preview table if contacts exist
  if (state.contacts && state.contacts.length) {
    const headers = Object.keys(state.contacts[0]);
    renderPreview(headers, state.contacts);
  }

  addLog('OutreachBot started — session restored', 'info');
  renderQueue();
  renderFollowups();
  renderLogs();
  renderInboxList();
  updatePreview();
})();

// ===== INBOX & CRM =====

// Each inbox record: { id, contact, timeline: [{type,title,text,time,channels,meeting}], status }
// status: 'sent' | 'replied' | 'meeting' | 'followup'

function upsertInboxRecord(contact, event) {
  const key = contact.email || contact.phone || contact.name || contact.id;
  let record = state.inbox.find(r => {
    const rk = r.contact.email || r.contact.phone || r.contact.name;
    return rk === key;
  });
  if (!record) {
    record = { id: Date.now() + Math.random(), contact: { ...contact }, timeline: [], status: 'sent' };
    state.inbox.unshift(record);
  }
  record.timeline.push({ ...event, time: event.time || new Date().toISOString() });
  // Update status based on event type
  if (event.type === 'meeting') record.status = 'meeting';
  else if (event.type === 'reply') record.status = 'replied';
  else if (event.type === 'followup') { if (record.status === 'sent') record.status = 'followup'; }
  saveState();
  renderInboxList();
}

// Also add inbox record when follow-up auto-sends
function addFollowupToInbox(fu, msg) {
  upsertInboxRecord(fu, {
    type: 'followup', title: 'Auto follow-up sent',
    text: msg, time: new Date().toISOString(),
    channels: state.channels,
  });
}

// ── Filter state ────────────────────────────────────────────
let inboxFilter     = 'all';
let selectedInboxId = null;
let inboxActionTab  = 'reply'; // 'reply' | 'meeting' | 'note'

// ── Filter pills ────────────────────────────────────────────
document.querySelectorAll('.inbox-filter-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.inbox-filter-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    inboxFilter = pill.dataset.filter;
    renderInboxList();
  });
});

// ── Export CRM ──────────────────────────────────────────────
document.getElementById('btn-export-crm')?.addEventListener('click', () => {
  const rows = ['Name,Email,Phone,Status,Last Activity,Meeting Date,Reply'];
  state.inbox.forEach(r => {
    const meeting = r.timeline.find(t => t.type === 'meeting');
    const reply   = r.timeline.find(t => t.type === 'reply');
    const last    = r.timeline[r.timeline.length - 1];
    rows.push([
      `"${r.contact.name || ''}"`,
      `"${r.contact.email || ''}"`,
      `"${r.contact.phone || ''}"`,
      `"${r.status}"`,
      `"${last ? new Date(last.time).toLocaleString() : ''}"`,
      `"${meeting?.meeting?.date ? meeting.meeting.date + ' ' + (meeting.meeting.time || '') : ''}"`,
      `"${reply?.text?.replace(/"/g, '""') || ''}"`,
    ].join(','));
  });
  downloadText('crm-export.csv', rows.join('\n'));
  showToast('CRM exported ✓', 'success');
});

// ── Render contact list ──────────────────────────────────────
function renderInboxList() {
  const listEl = document.getElementById('inbox-list');
  if (!listEl) return;

  let filtered = state.inbox;
  if (inboxFilter === 'replied')  filtered = state.inbox.filter(r => r.status === 'replied');
  if (inboxFilter === 'meeting')  filtered = state.inbox.filter(r => r.status === 'meeting');
  if (inboxFilter === 'followup') filtered = state.inbox.filter(r => r.status === 'followup');
  if (inboxFilter === 'pending')  filtered = state.inbox.filter(r => r.status === 'sent');

  if (!filtered.length) {
    listEl.innerHTML = '<div class="empty-state">No contacts match this filter.</div>';
    return;
  }

  listEl.innerHTML = filtered.map(r => {
    const hasReply   = r.timeline.some(t => t.type === 'reply');
    const hasMeeting = r.timeline.some(t => t.type === 'meeting');
    const last       = r.timeline[r.timeline.length - 1];
    const lastText   = last?.text || last?.title || '';
    const tags = [];
    if (hasReply)   tags.push(`<span class="ic-tag tag-replied">✅ Replied</span>`);
    if (hasMeeting) tags.push(`<span class="ic-tag tag-meeting">📅 Meeting</span>`);
    if (r.status === 'followup') tags.push(`<span class="ic-tag tag-followup">🔁 Follow-up</span>`);
    if (r.status === 'sent' && !hasReply) tags.push(`<span class="ic-tag tag-pending">⏳ No reply</span>`);
    return `
      <div class="inbox-contact-card ${r.id === selectedInboxId ? 'active' : ''} ${hasReply ? 'has-reply' : ''} ${hasMeeting ? 'has-meeting' : ''}"
           onclick="selectInboxRecord('${r.id}')">
        <div class="ic-name">${r.contact.name || 'Unknown'}</div>
        <div class="ic-meta">${r.contact.email || r.contact.phone || ''}</div>
        ${lastText ? `<div class="ic-preview">${lastText.slice(0, 70)}…</div>` : ''}
        <div class="ic-tags">${tags.join('')}</div>
      </div>`;
  }).join('');
}

// ── Select contact ───────────────────────────────────────────
function selectInboxRecord(id) {
  selectedInboxId = id;
  renderInboxList(); // re-render to highlight active
  renderInboxDetail();
}

// ── Render detail panel ──────────────────────────────────────
function renderInboxDetail() {
  const detailEl = document.getElementById('inbox-detail');
  if (!detailEl) return;

  const record = state.inbox.find(r => r.id == selectedInboxId);
  if (!record) {
    detailEl.innerHTML = `<div class="detail-empty"><span style="font-size:32px;">📬</span><span>Select a contact to view conversation</span></div>`;
    return;
  }

  const c = record.contact;
  const meeting = record.timeline.find(t => t.type === 'meeting');

  // Build status badges
  const badges = [];
  if (record.status === 'replied')  badges.push(`<span class="ic-tag tag-replied">✅ Replied</span>`);
  if (record.status === 'meeting')  badges.push(`<span class="ic-tag tag-meeting">📅 Meeting Scheduled</span>`);
  if (record.status === 'followup') badges.push(`<span class="ic-tag tag-followup">🔁 Follow-up Sent</span>`);
  if (record.status === 'sent')     badges.push(`<span class="ic-tag tag-pending">⏳ Awaiting Reply</span>`);

  // Build timeline HTML
  const tlIcons = { sent:'📤', reply:'💬', followup:'🔁', meeting:'📅', note:'📝' };
  const tlClass  = { sent:'sent', reply:'reply', followup:'followup', meeting:'meeting', note:'note' };

  const timelineHTML = record.timeline.map(ev => {
    const isMeeting = ev.type === 'meeting' && ev.meeting;
    const bodyClass = ev.type === 'reply' ? 'reply-body' : ev.type === 'meeting' ? 'meeting-body' : '';
    const bodyText  = isMeeting
      ? `📅 Date: ${ev.meeting.date || '—'}  🕐 Time: ${ev.meeting.time || '—'}  📍 Venue: ${ev.meeting.venue || '—'}\n📝 Notes: ${ev.meeting.notes || '—'}`
      : (ev.text || '');
    return `
      <div class="tl-item">
        <div class="tl-dot ${tlClass[ev.type] || ''}">${tlIcons[ev.type] || '•'}</div>
        <div class="tl-content">
          <div class="tl-time">${new Date(ev.time).toLocaleString()}</div>
          <div class="tl-title">${ev.title || (ev.type === 'sent' ? 'Message sent' : ev.type)}</div>
          ${bodyText ? `<div class="tl-body ${bodyClass}">${bodyText}</div>` : ''}
          ${ev.channels ? `<div style="margin-top:5px;display:flex;gap:4px;">${ev.channels.map(ch => `<span class="ch-tag">${channelIcon(ch)} ${ch}</span>`).join('')}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  detailEl.innerHTML = `
    <!-- Header -->
    <div class="card">
      <div class="detail-header">
        <div>
          <div class="detail-name">${c.name || 'Unknown'}</div>
          <div class="detail-sub">
            ${c.email ? `📧 ${c.email}` : ''} ${c.phone ? `📱 ${c.phone}` : ''}
            ${c.linkedin ? `💼 <a href="${c.linkedin}" target="_blank" style="color:var(--cyan-400);">LinkedIn</a>` : ''}
          </div>
          <div class="detail-status-badges">${badges.join('')}</div>
        </div>
        ${meeting?.meeting?.date ? `
          <div style="text-align:right;font-size:11px;font-family:var(--font-mono);color:var(--cyan-400);">
            📅 Meeting<br/>
            <strong style="font-size:13px;">${meeting.meeting.date}</strong>
            ${meeting.meeting.time ? `at ${meeting.meeting.time}` : ''}
          </div>` : ''}
      </div>
    </div>

    <!-- Timeline -->
    <div class="card">
      <div style="font-size:11px;font-family:var(--font-mono);color:var(--text-muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:14px;">Conversation Timeline</div>
      <div class="timeline">${timelineHTML || '<div style="color:var(--text-muted);font-size:12px;">No events yet</div>'}</div>
    </div>

    <!-- Action card -->
    <div class="inbox-action-card">
      <div class="inbox-action-tabs">
        <button class="inbox-action-tab ${inboxActionTab==='reply'?'active':''}"   onclick="setInboxTab('reply')">💬 Log Reply</button>
        <button class="inbox-action-tab ${inboxActionTab==='meeting'?'active':''}" onclick="setInboxTab('meeting')">📅 Schedule Meeting</button>
        <button class="inbox-action-tab ${inboxActionTab==='note'?'active':''}"    onclick="setInboxTab('note')">📝 Add Note</button>
      </div>

      ${inboxActionTab === 'reply' ? `
        <div class="form-group" style="margin-bottom:10px;">
          <label>Reply received from ${c.name || 'contact'}</label>
          <textarea id="inbox-reply-text" rows="3" placeholder="Paste or type what they replied..."></textarea>
        </div>
        <button class="btn-primary" onclick="saveInboxReply('${record.id}')">💾 Save Reply</button>
      ` : ''}

      ${inboxActionTab === 'meeting' ? `
        <div class="meeting-form">
          <div class="meeting-row">
            <div class="form-group">
              <label>Meeting Date</label>
              <input type="date" id="meeting-date"/>
            </div>
            <div class="form-group">
              <label>Meeting Time</label>
              <input type="time" id="meeting-time"/>
            </div>
          </div>
          <div class="form-group">
            <label>Venue / Link</label>
            <input type="text" id="meeting-venue" placeholder="Google Meet link or office address"/>
          </div>
          <div class="form-group">
            <label>Notes</label>
            <textarea id="meeting-notes" rows="2" placeholder="Agenda, topics to discuss..."></textarea>
          </div>
          <button class="btn-primary" onclick="saveMeeting('${record.id}')">📅 Save Meeting</button>
        </div>
      ` : ''}

      ${inboxActionTab === 'note' ? `
        <div class="form-group" style="margin-bottom:10px;">
          <label>Internal note</label>
          <textarea id="inbox-note-text" rows="3" placeholder="Internal note about this contact or conversation..."></textarea>
        </div>
        <button class="btn-primary" onclick="saveNote('${record.id}')">📝 Save Note</button>
      ` : ''}
    </div>
  `;
}

function setInboxTab(tab) {
  inboxActionTab = tab;
  renderInboxDetail();
}

function saveInboxReply(recordId) {
  const text = document.getElementById('inbox-reply-text')?.value.trim();
  if (!text) { showToast('Enter the reply text', 'error'); return; }
  const record = state.inbox.find(r => r.id == recordId);
  if (!record) return;
  record.timeline.push({ type: 'reply', title: 'Reply received', text, time: new Date().toISOString() });
  record.status = 'replied';
  saveState();
  renderInboxList();
  renderInboxDetail();
  addLog(`💬 Reply logged for ${record.contact.name || record.contact.email}`, 'success');
  showToast('Reply saved ✓', 'success');
}

function saveMeeting(recordId) {
  const date  = document.getElementById('meeting-date')?.value;
  const time  = document.getElementById('meeting-time')?.value;
  const venue = document.getElementById('meeting-venue')?.value.trim();
  const notes = document.getElementById('meeting-notes')?.value.trim();
  if (!date) { showToast('Pick a meeting date', 'error'); return; }
  const record = state.inbox.find(r => r.id == recordId);
  if (!record) return;
  record.timeline.push({
    type: 'meeting', title: 'Meeting scheduled',
    text: '', time: new Date().toISOString(),
    meeting: { date, time, venue, notes },
  });
  record.status = 'meeting';
  saveState();
  renderInboxList();
  renderInboxDetail();
  addLog(`📅 Meeting scheduled with ${record.contact.name || record.contact.email} on ${date}`, 'success');
  showToast('Meeting saved ✓', 'success');
}

function saveNote(recordId) {
  const text = document.getElementById('inbox-note-text')?.value.trim();
  if (!text) { showToast('Enter a note', 'error'); return; }
  const record = state.inbox.find(r => r.id == recordId);
  if (!record) return;
  record.timeline.push({ type: 'note', title: 'Note', text, time: new Date().toISOString() });
  saveState();
  renderInboxList();
  renderInboxDetail();
  showToast('Note saved ✓', 'success');
}

// ── Wire up to auto follow-up ────────────────────────────────
// Patch the auto follow-up sender to also log in inbox
const _origAutoFu = window._autoFuSend;

// ── Init inbox on restore ────────────────────────────────────
renderInboxList();

// ===== GEMINI AI TEMPLATE GENERATOR =====
(function () {
  // ── Config ──────────────────────────────────────────────────────────────
  // Gemini API key is injected via the backend proxy to keep it off the client.
  // The backend exposes POST /ai-generate  { prompt: string } → { text: string }
  // If you want to call Gemini directly from the browser (dev only), set GEMINI_KEY below.
  const GEMINI_KEY = ''; // leave blank → uses backend proxy at /ai-generate

  const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

  // ── Elements ─────────────────────────────────────────────────────────────
  const btnGenerate = document.getElementById('btn-ai-generate');
  const promptArea  = document.getElementById('ai-prompt');
  const targetSel   = document.getElementById('ai-target');
  const statusBox   = document.getElementById('ai-gen-status');

  if (!btnGenerate) return; // guard — compose tab not in DOM yet

  // ── Helpers ──────────────────────────────────────────────────────────────
  function setStatus(msg, type) {
    statusBox.style.display = 'block';
    statusBox.className     = `ai-gen-status ${type}`;
    statusBox.innerHTML     = msg;
  }
  function clearStatus() {
    statusBox.style.display = 'none';
    statusBox.textContent   = '';
  }

  // ── Core generate function ────────────────────────────────────────────────
  async function generateTemplate() {
    const prompt = promptArea.value.trim();
    if (!prompt) {
      setStatus('⚠️ Please enter a prompt first.', 'error');
      return;
    }

    btnGenerate.disabled    = true;
    btnGenerate.textContent = 'Generating…';
    setStatus('<span class="ai-spinner"></span> Gemini is writing your template…', 'loading');

    const systemInstruction =
      'You are an expert outreach copywriter. ' +
      'Write ONLY the message template text — no explanations, no subject-line labels, no markdown. ' +
      'Use {{name}}, {{email}}, {{phone}} as placeholders where natural. ' +
      'Keep it concise and human.';

    const fullPrompt = `${systemInstruction}\n\nUser request: ${prompt}`;

    try {
      let text = '';

      if (GEMINI_KEY) {
        // ── Direct Gemini API (dev / when key is embedded) ──────────────
        const res = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: fullPrompt }] }],
            generationConfig: { temperature: 0.8, maxOutputTokens: 400 },
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err?.error?.message || `Gemini error ${res.status}`);
        }

        const data = await res.json();
        text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

      } else {
        // ── Backend proxy at POST /ai-generate ───────────────────────────
        const res = await fetch(`${API}/ai-generate`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: fullPrompt }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err?.detail || `Backend error ${res.status}`);
        }

        const data = await res.json();
        text = data.text || '';
      }

      text = text.trim();

      if (!text) throw new Error('Gemini returned an empty response. Try a more specific prompt.');

      // ── Insert into the chosen textarea ────────────────────────────────
      const target = targetSel.value;
      if (target === 'main') {
        msgTpl.value = text;
        previewMode  = 'main';
        msgTpl.dispatchEvent(new Event('input'));        // trigger live preview
        msgTpl.focus();
      } else {
        fuTpl.value = text;
        previewMode  = 'followup';
        fuTpl.dispatchEvent(new Event('input'));
        fuTpl.focus();
      }

      setStatus('✅ Content generated! You can edit it freely before saving.', 'success');
      addLog(`AI generated ${target === 'main' ? 'main' : 'follow-up'} template via Gemini`, 'info');
      showToast('Template generated ✓', 'success');

    } catch (err) {
      setStatus(`❌ ${err.message}`, 'error');
      showToast('Generation failed', 'error');
    } finally {
      btnGenerate.disabled    = false;
      btnGenerate.textContent = '✨ Generate';
    }
  }

  // ── Event listeners ────────────────────────────────────────────────────
  btnGenerate.addEventListener('click', generateTemplate);

  promptArea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') generateTemplate();
  });

  // Clear status when user edits the prompt
  promptArea.addEventListener('input', clearStatus);
})();

// ===== PROFESSIONAL TEMPLATE LIBRARY =====
(function () {

  // ── Template Data ──────────────────────────────────────────────────────
  const TEMPLATES = [

    // ════════════════════ JOB PROPOSAL ════════════════════
    {
      ch: 'email', name: '💼 Job Proposal — Virtual Heights',
      isJobProposal: true,
      body: `Subject: Exciting Automation Opportunity for {{name}} — Virtual Heights

Hi {{name}},

I hope this message finds you well! I'm {{sender}} from {{company}}, a forward-thinking technology company building India's next-generation {{website}}.

We've been following your work and believe your skills align perfectly with an exciting opportunity we have right now. At {{company}}, we specialise in AI-driven automation that helps businesses save time, reduce costs, and scale faster.

We'd love to explore how you could contribute to our growing team and make an impact that truly matters.

🌐 Learn more about us: {{url}}

Would you be open to a quick 15-minute call this week? I'd love to share more details about the role and what we're building.

Looking forward to connecting!

Warm regards,
{{sender}}
{{company}} | {{website}}
{{url}}`
    },
    {
      ch: 'whatsapp', name: '💼 Job Proposal — Virtual Heights',
      isJobProposal: true,
      body: `Hi {{name}}! 👋

I'm {{sender}} from *{{company}}* 🚀

We build cutting-edge {{website}} solutions and we're looking for talented people to join our growing team!

Your profile caught our attention — we think you'd be a great fit for an exciting role we have open right now.

🌐 Check us out: {{url}}

Can we schedule a quick 10-minute call this week to tell you more? Just reply YES and I'll send over the details! ✅

— {{sender}} | {{company}} | {{url}}`
    },
    {
      ch: 'sms', name: '💼 Job Proposal — Virtual Heights',
      isJobProposal: true,
      body: `Hi {{name}}, I'm {{sender}} from {{company}}. We're hiring for our {{website}} team & think you'd be a great fit! Interested? Reply YES for details. Info: {{url}} | Opt out: STOP`
    },
    {
      ch: 'linkedin', name: '💼 Job Proposal — Virtual Heights',
      isJobProposal: true,
      body: `Hi {{name}},

I'm {{sender}}, representing {{company}} — we're building an innovative {{website}} platform that's transforming how businesses operate.

I came across your profile and was genuinely impressed by your experience and background. We're currently looking for talented professionals, and I believe you could be a strong fit for a key role on our team.

At {{company}}, you'll work on real-world automation challenges, grow rapidly, and be part of a team that's passionate about making technology work for people.

I'd love to connect and share more details. Would you be open to a brief conversation this week?

Looking forward to hearing from you!

Best regards,
{{sender}}
{{company}} | {{website}}
{{url}}`
    },
    {
      ch: 'all', name: '💼 Job Proposal Bundle — Virtual Heights',
      isJobProposal: true,
      body: `--- EMAIL ---
Subject: Exciting Automation Opportunity for {{name}} — {{company}}

Hi {{name}},

I hope this message finds you well! I'm {{sender}} from {{company}}, a forward-thinking technology company building India's next-generation {{website}}.

We've been following your work and believe your skills align perfectly with an exciting opportunity we have right now. At {{company}}, we specialise in AI-driven automation that helps businesses save time, reduce costs, and scale faster.

We'd love to explore how you could contribute to our growing team and make an impact that truly matters.

🌐 Learn more about us: {{url}}

Would you be open to a quick 15-minute call this week?

Warm regards,
{{sender}}
{{company}} | {{website}}
{{url}}

--- WHATSAPP ---
Hi {{name}} 👋 I'm {{sender}} from *{{company}}*! We're growing our {{website}} team and your profile looks like a great fit 🚀 Can we connect for 10 mins? Reply YES! Info: {{url}}

— {{sender}} | {{company}}

--- SMS ---
Hi {{name}}, {{sender}} from {{company}}. We're hiring for {{website}}! Interested? Reply YES. More: {{url}} | Stop: STOP

--- LINKEDIN ---
Hi {{name}}, I'm {{sender}} at {{company}}. We build {{website}} solutions and are looking for talented professionals. Would love to connect and share a great opportunity. Check us out: {{url}}

Warm regards,
{{sender}} | {{company}}`
    },

    // ════════════════════ EMAIL ════════════════════
    {
      ch: 'email', name: 'Cold Outreach — SaaS Product',
      body: `Subject: Quick question about your workflow, {{name}}

Hi {{name}},

I hope this message finds you well. I came across your profile and was genuinely impressed by your work.

I'm reaching out because we help professionals like you save 5+ hours a week through smart automation. Our platform handles repetitive tasks so you can focus on what actually matters.

Would you be open to a 15-minute call this week to explore if there's a fit?

Warm regards,
{{sender}}
{{company}} | {{website}}
{{url}}`
    },
    {
      ch: 'email', name: 'Follow-up After No Reply',
      body: `Subject: Following up — {{name}}

Hi {{name}},

I wanted to follow up on my previous message, as I know inboxes can get busy.

I genuinely believe what we've built could add real value to what you're doing. I'll keep this brief — would a quick 10-minute chat work for you this week?

If now isn't the right time, just let me know and I'll reach out later.

Warm regards,
{{sender}}
{{company}} | {{website}}
{{url}}`
    },
    {
      ch: 'email', name: 'Partnership Proposal',
      body: `Subject: Partnership opportunity — {{company}} × {{name}}'s team

Dear {{name}},

I'm reaching out to explore a potential collaboration between our organizations.

After reviewing what your team is building, I believe there's a compelling opportunity for us to work together — combining our strengths to deliver greater value to both our audiences.

I'd love to schedule a 20-minute introductory call at your convenience.

Warm regards,
{{sender}}
{{company}} | {{website}}
{{url}}`
    },
    {
      ch: 'email', name: 'Job Application / Networking',
      body: `Subject: Exploring opportunities at {{company}}

Hi {{name}},

I hope you're doing well. I'm {{sender}}, a {{company}} with [X] years of experience in [Your Domain].

I've been following {{company}}'s journey and am particularly inspired by [specific achievement or product]. I'd love to explore if there are any opportunities where my skills could contribute to your team's growth.

I've attached my resume for your reference. Would you be open to a brief conversation?

Thank you for your time,
{{company}}
{{email}} | [LinkedIn Profile]`
    },
    {
      ch: 'email', name: 'Event / Webinar Invitation',
      body: `Subject: You're invited — [Event Name] on [Date]

Hi {{name}},

I'd like to personally invite you to [Event Name], a [webinar/conference/workshop] designed for professionals looking to [key benefit].

📅 Date: [Date & Time]
📍 Location: [Venue / Online Link]
🎯 Topics: [Topic 1], [Topic 2], [Topic 3]

Spots are limited. Secure your place today — it's completely free.

[Register Now → Link]

Hope to see you there,
{{company}}`
    },

    // ════════════════════ WHATSAPP ════════════════════
    {
      ch: 'whatsapp', name: 'Warm Intro & Offer',
      body: `Hi {{name}} 👋

Hope you're having a great day!

I'm {{sender}} from {{company}}. We help [target audience] achieve [key result] without [common pain point].

I thought you might find this relevant based on your work. Would love to share more — do you have 5 minutes this week? 😊`
    },
    {
      ch: 'whatsapp', name: 'Quick Follow-up',
      body: `Hi {{name}}, just a quick follow-up on my earlier message 🙏

I know you're busy — no pressure at all! I just wanted to make sure it didn't get lost.

If you're interested, even a 10-min call would be great. Let me know what works for you! 🗓️`
    },
    {
      ch: 'whatsapp', name: 'Product Demo Invite',
      body: `Hello {{name}} 👋

I'd love to show you what we've been building at {{company}}. It's helped teams like yours [achieve key result] in just [timeframe].

Can I share a quick 2-min demo video? No strings attached — just want your honest feedback! 🎯`
    },
    {
      ch: 'whatsapp', name: 'Exclusive Offer / Discount',
      body: `Hi {{name}}! 🎉

We're running a special offer exclusively for professionals in your space — [X]% off [Product/Service] until [Date].

This is something I thought you'd find genuinely useful. Want me to share the details?

Reply YES and I'll send everything over right away! ✅`
    },
    {
      ch: 'whatsapp', name: 'Re-engagement After Silence',
      body: `Hi {{name}}, it's {{sender}} from {{company}} 😊

We haven't spoken in a while — I just wanted to check in and see how things are going for you.

If there's anything we can help with, I'm here. No hard sell — just genuinely wanted to reconnect! 🤝`
    },

    // ════════════════════ SMS ════════════════════
    {
      ch: 'sms', name: 'Short Cold Intro',
      body: `Hi {{name}}, I'm {{sender}} from {{company}}. We help [benefit]. Interested in a quick 10-min call? Reply YES or call {{phone}}. Opt out: STOP`
    },
    {
      ch: 'sms', name: 'Appointment Reminder',
      body: `Hi {{name}}, this is a reminder for your appointment on [Date] at [Time] with [Name/Company]. Reply CONFIRM or call us at [Phone] to reschedule.`
    },
    {
      ch: 'sms', name: 'Promotional Flash Deal',
      body: `{{name}}, FLASH DEAL 🔥 Get [X]% off [Product] today only! Use code [CODE] at [Link]. Limited slots — act fast. Reply STOP to opt out.`
    },
    {
      ch: 'sms', name: 'Follow-up After Meeting',
      body: `Hi {{name}}, great connecting today! As discussed, here's the link to [Resource/Proposal]: [Link]. Let me know if you have questions — [Your Name]`
    },
    {
      ch: 'sms', name: 'Event Reminder',
      body: `Hi {{name}}! Reminder: [Event Name] is tomorrow at [Time] 📅. Join here: [Link]. See you there! — [Your Name / Company]`
    },

    // ════════════════════ LINKEDIN ════════════════════
    {
      ch: 'linkedin', name: 'Cold Connection Request',
      body: `Hi {{name}},

I came across your profile and was impressed by your experience in [Field/Industry].

I'm {{sender}}, working on [Brief Description]. I'd love to connect and explore potential synergies.

Looking forward to being part of your network!`
    },
    {
      ch: 'linkedin', name: 'After Connection — First Message',
      body: `Hi {{name}},

Thank you for connecting! I genuinely enjoy following your insights on [topic].

I wanted to briefly introduce myself — I'm building [Product/Service] that helps [target audience] with [key benefit]. Given your background, I'd value your perspective.

Would you be open to a short conversation sometime this week?

Best,
{{company}}`
    },
    {
      ch: 'linkedin', name: 'Recruiter / Talent Outreach',
      body: `Hi {{name}},

Your profile stood out to me — your experience in [Skill/Domain] is exactly what our team is looking for.

We're {{company}}, and we're hiring for [Role]. It's a [remote/hybrid] opportunity with [key perk].

Would you be open to learning more, even if you're not actively looking?

Best regards,
{{company}}`
    },
    {
      ch: 'linkedin', name: 'Mutual Connection Intro',
      body: `Hi {{name}},

I noticed we're both connected with [Mutual Connection] — small world!

I'm {{sender}} and I work on [Brief Role]. I've been following your content and find your take on [Topic] really insightful.

I'd love to connect and learn more about your work. No agenda — just building a genuine network.`
    },
    {
      ch: 'linkedin', name: 'Thought Leadership Engagement',
      body: `Hi {{name}},

I recently read your post on [Topic] and it really resonated with me — especially your point about [specific insight].

It inspired me to think about [related idea]. I'd love to exchange thoughts on this when you have a moment.

Wishing you a great week ahead!`
    },

    // ════════════════════ ALL CHANNELS ════════════════════
    {
      ch: 'all', name: '🌐 Universal Cold Outreach Bundle',
      body: `--- EMAIL ---
Subject: Quick question for you, {{name}}

Hi {{name}},

I hope you're well. I'm {{sender}} from {{company}} — we help businesses achieve more through AI-driven automation.

Would a 15-min call this week work for you?

Warm regards,
{{sender}}
{{company}} | {{website}}
{{url}}

--- WHATSAPP ---
Hi {{name}} 👋 I'm {{sender}} from *{{company}}*. We help businesses with AI-driven automation. Do you have 5 mins to chat this week? 😊

— {{sender}} | {{company}}

--- SMS ---
Hi {{name}}, {{sender}} from {{company}}. We help automate your business workflows. Quick call? Reply YES. Stop: STOP

--- LINKEDIN ---
Hi {{name}}, I came across your profile and see strong alignment with what we're building at {{company}}. I'd love to connect and share something relevant to your work.

Warm regards,
{{sender}} | {{company}} | {{url}}`
    },
    {
      ch: 'all', name: '🌐 Universal Follow-up Bundle',
      body: `--- EMAIL ---
Subject: Following up, {{name}}

Hi {{name}},

I'm checking back in to see if you've had a chance to consider my previous note. I'd love just 10 minutes at your convenience.

Warm regards,
{{sender}}
{{company}} | {{website}}
{{url}}

--- WHATSAPP ---
Hi {{name}}, just a gentle follow-up on my earlier message 🙏 Happy to share more details whenever suits you!

— {{sender}} | {{company}}

--- SMS ---
Hi {{name}}, {{sender}} from {{company}} — following up on my earlier msg. Quick chat? Reply YES. Stop: STOP

--- LINKEDIN ---
Hi {{name}}, following up on my previous message. I understand you're busy — no rush. Happy to connect whenever works for you.

Warm regards,
{{sender}} | {{company}} | {{url}}`
    },
    {
      ch: 'all', name: '🌐 Event Invite Bundle',
      body: `--- EMAIL ---
Subject: You're invited, {{name}} — [Event Name]

Hi {{name}}, I'd love to invite you to [Event] on [Date]. It's free and highly relevant to your work. Register here: [Link]

--- WHATSAPP ---
Hi {{name}} 🎉 You're invited to [Event Name] on [Date]! It's free. Grab your spot here: [Link] 🙌

--- SMS ---
{{name}}, join us at [Event] on [Date]! Free registration: [Link]. Reply STOP to opt out.

--- LINKEDIN ---
Hi {{name}}, I'm hosting [Event] on [Date] and immediately thought of you. Would love to have you join. Link: [URL].`
    },
  ];

  // ── Render ─────────────────────────────────────────────────────────────
  const BADGE_CLASS = { email:'badge-email', whatsapp:'badge-whatsapp', sms:'badge-sms', linkedin:'badge-linkedin', all:'badge-all' };
  const BADGE_LABEL = { email:'📧 Email', whatsapp:'📱 WhatsApp', sms:'💬 SMS', linkedin:'💼 LinkedIn', all:'🌐 All Channels' };
  const CH_CLASS    = { email:'ch-email', whatsapp:'ch-whatsapp', sms:'ch-sms', linkedin:'ch-linkedin', all:'ch-all' };

  let activeTab = 'all';

  function renderTemplates() {
    const grid = document.getElementById('tpl-lib-grid');
    if (!grid) return;
    const filtered = activeTab === 'all' ? TEMPLATES : TEMPLATES.filter(t => t.ch === activeTab);
    grid.innerHTML = filtered.map((t, idx) => {
      // Pre-fill brand vars in the preview so user sees real content
      const sc = state.senderConfig;
      const previewBody = t.body
        .replace(/{{sender}}/g,  sc.sender_name  || 'Vhits')
        .replace(/{{company}}/g, sc.company_name || 'Virtual Heights')
        .replace(/{{website}}/g, sc.website_name || 'Automation System')
        .replace(/{{url}}/g,     sc.website_url  || 'https://virtualheights.in');
      const jobBadge = t.isJobProposal
        ? `<span class="tpl-card-badge" style="background:rgba(245,158,11,0.2);color:#fbbf24;border:1px solid rgba(245,158,11,0.4);margin-left:4px;">💼 Job Proposal</span>`
        : '';
      return `
      <div class="tpl-card ${CH_CLASS[t.ch] || ''}${t.isJobProposal ? ' job-proposal-card' : ''}" data-idx="${TEMPLATES.indexOf(t)}" title="Click to load into composer">
        <div class="tpl-card-head">
          <span class="tpl-card-name">${t.name}</span>
          <div style="display:flex;gap:4px;flex-wrap:wrap;">${jobBadge}<span class="tpl-card-badge ${BADGE_CLASS[t.ch]}">${BADGE_LABEL[t.ch]}</span></div>
        </div>
        <div class="tpl-card-preview">${previewBody}</div>
        <div class="tpl-card-insert">${t.isJobProposal ? '↳ Click — brand vars auto-filled & channel set' : '↳ Click to load into Main Template'}</div>
      </div>`; 
    }).join('');

    // Click to load
    grid.querySelectorAll('.tpl-card').forEach(card => {
      card.addEventListener('click', () => {
        const tpl = TEMPLATES[parseInt(card.dataset.idx)];
        if (!tpl) return;

        // Resolve brand variables so they show filled in the textarea
        const sc = state.senderConfig;
        const resolved = tpl.body
          .replace(/{{sender}}/g,  sc.sender_name  || 'Vhits')
          .replace(/{{company}}/g, sc.company_name || 'Virtual Heights')
          .replace(/{{website}}/g, sc.website_name || 'Automation System')
          .replace(/{{url}}/g,     sc.website_url  || 'https://virtualheights.in');

        // Load into Main Template textarea
        const msgTplEl = document.getElementById('msg-template');
        if (msgTplEl) {
          msgTplEl.value = resolved;
          msgTplEl.dispatchEvent(new Event('input')); // trigger live preview
          msgTplEl.focus();
          msgTplEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        // If job proposal — auto-select matching channel
        if (tpl.isJobProposal && tpl.ch !== 'all') {
          document.querySelectorAll('.channel-card input[type=checkbox]').forEach(cb => {
            cb.checked = (cb.value.toLowerCase() === tpl.ch);
          });
          refreshChannelCards();
          showToast(`✅ "${tpl.name}" loaded · Channel auto-set to ${tpl.ch.toUpperCase()} · Brand vars applied`, 'success');
        } else if (tpl.isJobProposal && tpl.ch === 'all') {
          // Select all channels for the bundle
          document.querySelectorAll('.channel-card input[type=checkbox]').forEach(cb => { cb.checked = true; });
          refreshChannelCards();
          showToast(`✅ "${tpl.name}" loaded · All channels selected · Brand vars applied`, 'success');
        } else {
          showToast(`✅ "${tpl.name}" loaded into Main Template`, 'success');
        }
      });
    });
  }

  // ── Tab switching ──────────────────────────────────────────────────────
  const tabContainer = document.getElementById('tpl-channel-tabs');
  if (tabContainer) {
    tabContainer.querySelectorAll('.tpl-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        tabContainer.querySelectorAll('.tpl-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeTab = btn.dataset.ch;
        renderTemplates();
      });
    });
  }

  // Init
  renderTemplates();
})();