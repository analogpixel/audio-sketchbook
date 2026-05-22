// ──────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────
const _savedView = (() => { try { return JSON.parse(localStorage.getItem('sketchbook-view')); } catch { return null; } })();
const state = {
  items: {},      // id -> item data
  pan: _savedView?.pan ?? { x: 80, y: 80 },
  zoom: _savedView?.zoom ?? 1,
  dragging: null, // { id, startMX, startMY, origX, origY }
  panning: false,
  panStart: { x: 0, y: 0 },
};

const audioEls = {};   // id -> HTMLAudioElement
const animFrames = {}; // id -> rAF handle

// ──────────────────────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupViewport();
  await loadCanvas();
  document.getElementById('btn-record').addEventListener('click', openRecordModal);
  document.getElementById('btn-reset').addEventListener('click', resetView);
});

async function loadCanvas() {
  const items = await api('/api/canvas');
  items.forEach(addItemToCanvas);
}

function addItemToCanvas(item) {
  state.items[item.id] = item;
  const el = item.type === 'audio' ? buildAudioEl(item) : buildNoteEl(item);
  el.id = `item-${item.id}`;
  el.classList.add('item');
  el.style.left = item.x + 'px';
  el.style.top = item.y + 'px';
  el.style.zIndex = 10;
  document.getElementById('canvas-container').appendChild(el);
  if (item.type === 'audio' && item.waveform?.length) {
    requestAnimationFrame(() => paintWaveform(item.id));
  }
}

// ──────────────────────────────────────────────────────────────
// Audio card
// ──────────────────────────────────────────────────────────────
function buildAudioEl(item) {
  const div = document.createElement('div');
  div.innerHTML = audioCardHTML(item);
  const card = div.firstElementChild;
  setupHeaderDrag(card.querySelector('.card-header'), item.id);
  const wc = card.querySelector('.waveform-canvas');
  if (wc) {
    wc.addEventListener('mousedown', e => {
      e.stopPropagation();
      const rect = wc.getBoundingClientRect();
      seekAudio(item.id, (e.clientX - rect.left) / rect.width);
    });
  }
  return card;
}

function audioCardHTML(item) {
  const linksHTML = item.links.map(linkRowHTML).join('');
  return `
<div class="audio-card" data-id="${item.id}">
  <div class="card-header">
    <span class="drag-handle">⠿</span>
    <input class="card-title" value="${esc(item.title)}" placeholder="untitled"
      onchange="saveField('${item.id}','title',this.value)"
      onkeydown="if(event.key==='Enter')this.blur()"
      onmousedown="event.stopPropagation()">
    <button class="danger" onclick="deleteItem('${item.id}')" title="Delete">✕</button>
  </div>
  <div class="waveform-wrap">
    ${item.waveform?.length
      ? `<canvas class="waveform-canvas" data-id="${item.id}"></canvas>`
      : `<div class="waveform-empty">no waveform</div>`}
  </div>
  <div class="transport">
    <button class="btn-play" onclick="togglePlay('${item.id}')">▶</button>
    <span class="time-display" id="time-${item.id}">0:00 / 0:00</span>
    <button class="btn-copy" id="copy-${item.id}" onclick="copyToClipboard('${item.id}')" title="Copy file to clipboard">Copy</button>
  </div>
  <div class="card-notes-wrap">
    <textarea class="card-notes" placeholder="notes…"
      onblur="saveField('${item.id}','notes',this.value)"
      onmousedown="event.stopPropagation()">${esc(item.notes || '')}</textarea>
  </div>
  <div class="card-links">
    <div class="links-header">
      <span class="links-label">Links</span>
      <button class="btn-add-link" onclick="openBrowser('${item.id}')">+ Add</button>
    </div>
    <div class="links-list" id="links-${item.id}">${linksHTML}</div>
  </div>
</div>`;
}

function linkRowHTML(link) {
  const icon = link.link_type === 'ableton' ? '🎛' : '📁';
  return `<div class="link-row" id="link-${link.id}">
    <span class="link-icon">${icon}</span>
    <span class="link-label" onclick="launchPath('${esc(link.path)}')" title="${esc(link.path)}">${esc(link.label)}</span>
    <button class="danger" onclick="removeLink('${link.id}')">✕</button>
  </div>`;
}

// ──────────────────────────────────────────────────────────────
// Note card
// ──────────────────────────────────────────────────────────────
function buildNoteEl(item) {
  const div = document.createElement('div');
  div.innerHTML = noteCardHTML(item);
  const card = div.firstElementChild;
  setupHeaderDrag(card.querySelector('.card-header'), item.id);
  return card;
}

function noteCardHTML(item) {
  return `
<div class="note-card" data-id="${item.id}">
  <div class="card-header">
    <span class="drag-handle">⠿</span>
    <input class="card-title" value="${esc(item.title)}" placeholder="note"
      onchange="saveField('${item.id}','title',this.value)"
      onkeydown="if(event.key==='Enter')this.blur()"
      onmousedown="event.stopPropagation()">
    <button class="danger" onclick="deleteItem('${item.id}')" title="Delete">✕</button>
  </div>
  <div class="note-body">
    <textarea class="note-text" placeholder="start typing…"
      onblur="saveField('${item.id}','notes',this.value)"
      onmousedown="event.stopPropagation()">${esc(item.notes || '')}</textarea>
  </div>
</div>`;
}

// ──────────────────────────────────────────────────────────────
// Drag setup (shared)
// ──────────────────────────────────────────────────────────────
function setupHeaderDrag(header, id) {
  header.addEventListener('mousedown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
    e.preventDefault();
    const item = state.items[id];
    state.dragging = { id, startMX: e.clientX, startMY: e.clientY, origX: item.x, origY: item.y };
  });
}

// ──────────────────────────────────────────────────────────────
// Waveform rendering
// ──────────────────────────────────────────────────────────────
function paintWaveform(id, currentTime = 0, duration = 0) {
  const el = document.querySelector(`#item-${id} .waveform-canvas`);
  if (!el) return;
  const peaks = state.items[id]?.waveform;
  if (!peaks?.length) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = el.offsetWidth || 280;
  const cssH = el.offsetHeight || 68;
  if (el.width !== cssW * dpr || el.height !== cssH * dpr) {
    el.width = cssW * dpr;
    el.height = cssH * dpr;
  }

  const ctx = el.getContext('2d');
  ctx.clearRect(0, 0, el.width, el.height);
  ctx.save();
  ctx.scale(dpr, dpr);

  const bw = cssW / peaks.length;
  const progress = duration > 0 ? currentTime / duration : 0;

  peaks.forEach((v, i) => {
    const bh = Math.max(2, v * cssH * 0.88);
    ctx.fillStyle = i / peaks.length < progress ? 'rgba(99,102,241,0.9)' : 'rgba(99,102,241,0.2)';
    ctx.fillRect(i * bw + 0.5, (cssH - bh) / 2, Math.max(0.8, bw - 0.8), bh);
  });

  if (duration > 0) {
    ctx.fillStyle = 'rgba(79,70,229,0.9)';
    ctx.fillRect(progress * cssW - 1, 0, 2, cssH);
  }

  ctx.restore();
}

// ──────────────────────────────────────────────────────────────
// Audio playback
// ──────────────────────────────────────────────────────────────
function getAudio(id) {
  if (!audioEls[id]) {
    const a = new Audio(`/api/audio/${id}`);
    a.preload = 'metadata';
    a.addEventListener('ended', () => {
      stopWaveformAnim(id);
      paintWaveform(id, 0, a.duration);
      updatePlayBtn(id, false);
      document.querySelector(`#item-${id} .audio-card`)?.classList.remove('playing');
    });
    a.addEventListener('loadedmetadata', () => updateTimeDisplay(id, a));
    audioEls[id] = a;
  }
  return audioEls[id];
}

function togglePlay(id) {
  const a = getAudio(id);
  if (a.paused) {
    Object.keys(audioEls).forEach(oid => {
      if (oid !== id && !audioEls[oid].paused) {
        audioEls[oid].pause();
        stopWaveformAnim(oid);
        updatePlayBtn(oid, false);
        document.querySelector(`#item-${oid} .audio-card`)?.classList.remove('playing');
      }
    });
    a.play();
    startWaveformAnim(id);
    updatePlayBtn(id, true);
    document.querySelector(`#item-${id} .audio-card`)?.classList.add('playing');
  } else {
    a.pause();
    stopWaveformAnim(id);
    updatePlayBtn(id, false);
    document.querySelector(`#item-${id} .audio-card`)?.classList.remove('playing');
  }
}

function seekAudio(id, fraction) {
  const a = getAudio(id);
  const seek = () => {
    a.currentTime = fraction * a.duration;
    paintWaveform(id, a.currentTime, a.duration);
    updateTimeDisplay(id, a);
  };
  if (a.readyState >= 1) seek();
  else a.addEventListener('loadedmetadata', seek, { once: true });
  if (a.paused) togglePlay(id);
}

function startWaveformAnim(id) {
  const a = getAudio(id);
  const tick = () => {
    if (!a.paused && !a.ended) {
      paintWaveform(id, a.currentTime, a.duration);
      updateTimeDisplay(id, a);
      animFrames[id] = requestAnimationFrame(tick);
    } else {
      delete animFrames[id];
    }
  };
  if (animFrames[id]) cancelAnimationFrame(animFrames[id]);
  animFrames[id] = requestAnimationFrame(tick);
}

function stopWaveformAnim(id) {
  if (animFrames[id]) { cancelAnimationFrame(animFrames[id]); delete animFrames[id]; }
}

function updatePlayBtn(id, playing) {
  const btn = document.querySelector(`#item-${id} .btn-play`);
  if (btn) btn.textContent = playing ? '⏸' : '▶';
}

function updateTimeDisplay(id, audio) {
  const el = document.getElementById(`time-${id}`);
  if (el) el.textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(audio.duration || 0)}`;
}

function fmtTime(s) {
  if (!isFinite(s)) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// ──────────────────────────────────────────────────────────────
// Viewport / canvas transform
// ──────────────────────────────────────────────────────────────
let _saveViewTimer = null;
function updateTransform() {
  document.getElementById('canvas-container').style.transform =
    `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
  clearTimeout(_saveViewTimer);
  _saveViewTimer = setTimeout(() => {
    localStorage.setItem('sketchbook-view', JSON.stringify({ pan: state.pan, zoom: state.zoom }));
  }, 300);
}

function screenToCanvas(sx, sy) {
  const r = document.getElementById('viewport').getBoundingClientRect();
  return { x: (sx - r.left - state.pan.x) / state.zoom, y: (sy - r.top - state.pan.y) / state.zoom };
}

function resetView() {
  state.pan = { x: 80, y: 80 };
  state.zoom = 1;
  updateTransform();
}

// ──────────────────────────────────────────────────────────────
// Viewport events
// ──────────────────────────────────────────────────────────────
function setupViewport() {
  const vp = document.getElementById('viewport');
  updateTransform();

  vp.addEventListener('wheel', e => {
    e.preventDefault();
    const { x, y } = screenToCanvas(e.clientX, e.clientY);
    const delta = e.ctrlKey ? -e.deltaY * 0.01 : -e.deltaY * 0.001;
    const nz = Math.min(3, Math.max(0.2, state.zoom * (1 + delta)));
    state.pan.x += x * (state.zoom - nz);
    state.pan.y += y * (state.zoom - nz);
    state.zoom = nz;
    updateTransform();
  }, { passive: false });

  // pan on canvas background
  vp.addEventListener('mousedown', e => {
    const cc = document.getElementById('canvas-container');
    if (e.target === vp || e.target === cc) {
      e.preventDefault();
      state.panning = true;
      state.panStart = { x: e.clientX - state.pan.x, y: e.clientY - state.pan.y };
      vp.classList.add('panning');
    }
  });

  // double-click on canvas background → create note
  vp.addEventListener('dblclick', async e => {
    const cc = document.getElementById('canvas-container');
    if (e.target !== vp && e.target !== cc) return;
    const { x, y } = screenToCanvas(e.clientX, e.clientY);
    const item = await api('/api/notes', 'POST', { x, y });
    if (!item) return;
    addItemToCanvas(item);
    // focus the textarea immediately
    requestAnimationFrame(() => {
      document.querySelector(`#item-${item.id} .note-text`)?.focus();
    });
  });

  window.addEventListener('mousemove', e => {
    if (state.dragging) {
      const { id, startMX, startMY, origX, origY } = state.dragging;
      const el = document.getElementById(`item-${id}`);
      const nx = origX + (e.clientX - startMX) / state.zoom;
      const ny = origY + (e.clientY - startMY) / state.zoom;
      state.items[id].x = nx;
      state.items[id].y = ny;
      el.style.left = nx + 'px';
      el.style.top = ny + 'px';
      return;
    }
    if (state.panning) {
      state.pan.x = e.clientX - state.panStart.x;
      state.pan.y = e.clientY - state.panStart.y;
      updateTransform();
    }
  });

  window.addEventListener('mouseup', () => {
    if (state.dragging) { debounceSavePosition(state.dragging.id); state.dragging = null; }
    if (state.panning) { state.panning = false; document.getElementById('viewport').classList.remove('panning'); }
  });

  vp.addEventListener('dragover', e => {
    e.preventDefault();
    document.getElementById('drop-overlay').classList.add('visible');
  });
  vp.addEventListener('dragleave', e => {
    if (!vp.contains(e.relatedTarget)) document.getElementById('drop-overlay').classList.remove('visible');
  });
  vp.addEventListener('drop', handleFileDrop);
}

// ──────────────────────────────────────────────────────────────
// File drop
// ──────────────────────────────────────────────────────────────
async function handleFileDrop(e) {
  e.preventDefault();
  document.getElementById('drop-overlay').classList.remove('visible');
  const { x, y } = screenToCanvas(e.clientX, e.clientY);
  const audioExts = new Set(['wav','aif','aiff','mp3','flac','ogg','m4a','aac','opus']);
  const files = [...e.dataTransfer.files].filter(f => {
    if (f.type.startsWith('audio/')) return true;
    return audioExts.has(f.name.split('.').pop().toLowerCase());
  });
  for (let i = 0; i < files.length; i++) {
    const fd = new FormData();
    fd.append('file', files[i]);
    const item = await fetch(`/api/upload?x=${x + i * 340}&y=${y}`, { method: 'POST', body: fd }).then(r => r.json());
    addItemToCanvas(item);
  }
}

// ──────────────────────────────────────────────────────────────
// CRUD helpers
// ──────────────────────────────────────────────────────────────
const _saveTimers = {};
function debounceSavePosition(id) {
  clearTimeout(_saveTimers[id]);
  _saveTimers[id] = setTimeout(() => {
    const { x, y } = state.items[id];
    api(`/api/items/${id}`, 'PATCH', { x, y });
  }, 400);
}

function saveField(id, field, value) {
  api(`/api/items/${id}`, 'PATCH', { [field]: value });
}

async function deleteItem(id) {
  if (!confirm('Delete this item?')) return;
  if (audioEls[id]) { audioEls[id].pause(); delete audioEls[id]; }
  stopWaveformAnim(id);
  await api(`/api/items/${id}`, 'DELETE');
  document.getElementById(`item-${id}`)?.remove();
  delete state.items[id];
}

async function copyToClipboard(id) {
  const btn = document.getElementById(`copy-${id}`);
  const orig = btn.textContent;
  btn.disabled = true;
  const res = await api(`/api/items/${id}/copy`, 'POST');
  if (res) {
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
  } else {
    btn.textContent = '✗ Failed';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
  }
}

async function removeLink(linkId) {
  await api(`/api/links/${linkId}`, 'DELETE');
  document.getElementById(`link-${linkId}`)?.remove();
}

async function launchPath(path) {
  await api(`/api/launch?path=${encodeURIComponent(path)}`, 'POST');
}

// ──────────────────────────────────────────────────────────────
// File browser modal
// ──────────────────────────────────────────────────────────────
let _browserItemId = null;
let _browserSelected = null;
let _browserPath = null;

async function openBrowser(itemId) {
  _browserItemId = itemId;
  _browserSelected = null;
  await browseDir('~');
  document.getElementById('modal-browser').classList.remove('hidden');
}

async function browseDir(path) {
  _browserPath = path;
  const data = await api(`/api/browse?path=${encodeURIComponent(path)}`);
  document.getElementById('browser-path-bar').textContent = data.path;

  const list = document.getElementById('browser-list');
  list.innerHTML = '';

  if (data.path !== data.parent) {
    const up = document.createElement('div');
    up.className = 'browser-entry browser-up';
    up.innerHTML = `<span class="entry-icon">↩</span><span class="entry-name">..</span>`;
    up.addEventListener('click', () => browseDir(data.parent));
    list.appendChild(up);
  }

  data.entries.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'browser-entry';
    const icon = entry.is_ableton ? '🎛' : entry.is_dir ? '📁' : entry.is_audio ? '🎵' : '📄';
    const badge = entry.is_ableton ? '<span class="entry-badge">als</span>' : '';
    row.innerHTML = `<span class="entry-icon">${icon}</span><span class="entry-name">${esc(entry.name)}</span>${badge}`;
    if (entry.is_dir && !entry.is_ableton) row.addEventListener('dblclick', () => browseDir(entry.path));
    row.addEventListener('click', () => {
      list.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
      row.classList.add('selected');
      _browserSelected = entry;
    });
    list.appendChild(row);
  });
}

async function confirmBrowserSelection() {
  const entry = _browserSelected;
  const path = entry ? entry.path : _browserPath;
  const linkType = entry?.is_ableton ? 'ableton' : 'folder';
  const link = await api(`/api/items/${_browserItemId}/links`, 'POST', { link_type: linkType, path, label: '' });
  document.getElementById(`links-${_browserItemId}`)?.insertAdjacentHTML('beforeend', linkRowHTML(link));
  closeModal('modal-browser');
}

// ──────────────────────────────────────────────────────────────
// Record modal
// ──────────────────────────────────────────────────────────────
let _recDevices = [];

async function openRecordModal() {
  document.getElementById('modal-record').classList.remove('hidden');
  _recDevices = await api('/api/devices');
  const lastDev = localStorage.getItem('sketchbook-record-device');
  document.getElementById('record-device').innerHTML =
    _recDevices.map(d => `<option value="${d.id}"${String(d.id) === lastDev ? ' selected' : ''}>${esc(d.name)} (${d.channels}ch)</option>`).join('');
  document.getElementById('record-status').innerHTML = '';
}

async function startRecording() {
  const devId = parseInt(document.getElementById('record-device').value);
  localStorage.setItem('sketchbook-record-device', String(devId));
  const sr = _recDevices.find(d => d.id === devId)?.samplerate || 44100;
  await api(`/api/record/start?device_id=${devId}&samplerate=${sr}`, 'POST');
  document.getElementById('btn-start-rec').disabled = true;
  document.getElementById('btn-stop-rec').disabled = false;
  document.getElementById('record-device').disabled = true;
  document.getElementById('record-status').innerHTML = '<span class="rec-dot"></span> Recording…';
}

async function stopRecording() {
  const { x, y } = viewCenter();
  const item = await api(`/api/record/stop?x=${x}&y=${y}`, 'POST');
  document.getElementById('btn-start-rec').disabled = false;
  document.getElementById('btn-stop-rec').disabled = true;
  document.getElementById('record-device').disabled = false;
  document.getElementById('record-status').innerHTML = '✓ Saved';
  if (item) addItemToCanvas(item);
  closeModal('modal-record');
}

function viewCenter() {
  const vp = document.getElementById('viewport');
  const r = vp.getBoundingClientRect();
  return screenToCanvas(r.left + vp.clientWidth / 2, r.top + vp.clientHeight / 2);
}

// ──────────────────────────────────────────────────────────────
// Modal helpers
// ──────────────────────────────────────────────────────────────
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.modal:not(.hidden)').forEach(m => m.classList.add('hidden'));
});

// ──────────────────────────────────────────────────────────────
// API helper
// ──────────────────────────────────────────────────────────────
async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  if (!res.ok) { console.error(`API ${method} ${path}:`, await res.text()); return null; }
  return res.json();
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
