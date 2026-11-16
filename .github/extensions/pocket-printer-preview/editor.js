const $ = selector => document.querySelector(selector);
const labels = { heading: 'Name & title', day: 'Day & daylight', walk: 'Walk', meetings: 'Meetings', bottom: 'Joke / Sudoku / art' };
let state, draft, pending = false, sending = false, synced = true, timer, dragId;
let inspectedId = null, decodedId = null, confirming = false, lastJobId = null, inspecting = false;
let previewTimer, attemptedInspectionKey = null;
let selecting = false, scanRequest = false, deviceList = '';
const targetPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function error(message) { $('#error').textContent = message; $('#error').hidden = !message; }
async function post(name, input) {
  const response = await fetch(name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? 'Editor request failed.');
  return result;
}
async function resyncAfterFailure(failure) {
  try {
    const response = await fetch('state', { cache: 'no-store' });
    if (!response.ok) throw new Error('Editor connection unavailable.');
    const latest = await response.json();
    const changed = latest.revision !== state.revision;
    setState(latest);
    if (changed && !pending && !sending && synced) { draft = structuredClone(latest.draft); drawSections(); }
    error(failure.message);
  } catch (recoveryFailure) {
    error(`${failure.message} Could not refresh editor state: ${recoveryFailure.message}`);
  }
}
function setState(value) {
  state = value;
  $('#render-status').textContent = pending ? 'Unsaved changes; updating preview...' :
    value.renderedRevision === value.revision ? 'Preview matches this draft' : 'Current draft has no printable preview';
  const valid = !pending && value.image && value.renderedRevision === value.revision;
  $('#card').hidden = !valid;
  if (valid) {
    $('#card').src = `image.png?revision=${value.revision}`;
    $('#metadata').textContent = `${value.image.width} x ${value.image.height} pixels | Estimated paper: ${value.image.estimatedPaperMm.toFixed(1)} mm`;
  } else $('#metadata').textContent = '';
  $('#save-status').textContent = value.saved ? 'Saved draft open; Save to keep further edits' : 'Unsaved example';
  error(value.error?.message ?? '');
  drawPrinting();
  queueInspection();
}
function field(key, label, multiline = false) {
  const wrapper = document.createElement('div');
  const caption = document.createElement('label');
  const input = document.createElement(multiline ? 'textarea' : 'input');
  input.id = `field-${key}`; caption.htmlFor = input.id; caption.textContent = label;
  input.value = draft[key]; input.maxLength = ['name', 'title'].includes(key) ? 128 : 2048;
  input.addEventListener('input', () => { draft[key] = input.value; changed(); });
  wrapper.append(caption, input);
  return wrapper;
}
function selector(key, label, choices) {
  const wrapper = document.createElement('div');
  const caption = document.createElement('label');
  const select = document.createElement('select');
  select.id = `field-${key}`; caption.htmlFor = select.id; caption.textContent = label;
  for (const [value, text] of choices) {
    const option = document.createElement('option');
    option.value = value; option.textContent = text; select.append(option);
  }
  select.value = draft[key];
  select.addEventListener('change', () => { draft[key] = select.value; drawSections(); changed(); });
  wrapper.append(caption, select); return wrapper;
}
function move(id, before) {
  if (id === before) return;
  const order = draft.order.filter(value => value !== id);
  const index = before === null ? order.length : order.indexOf(before);
  order.splice(index, 0, id); draft.order = order;
  drawSections(); changed();
}
function drawSections() {
  const container = $('#sections'); container.replaceChildren();
  draft.order.forEach((id, index) => {
    const section = document.createElement('article');
    section.className = 'section'; section.dataset.enabled = draft.enabled[id];
    const header = document.createElement('header');
    header.draggable = true;
    header.addEventListener('dragstart', event => { dragId = id; event.dataTransfer.setData('text/plain', id); event.dataTransfer.effectAllowed = 'move'; });
    header.addEventListener('dragend', () => { dragId = null; document.querySelectorAll('.drop-target').forEach(node => node.classList.remove('drop-target')); });
    section.addEventListener('dragover', event => { if (dragId && dragId !== id) { event.preventDefault(); section.classList.add('drop-target'); } });
    section.addEventListener('dragleave', () => section.classList.remove('drop-target'));
    section.addEventListener('drop', event => {
      event.preventDefault(); section.classList.remove('drop-target');
      if (dragId && dragId !== id) {
        const after = event.clientY > section.getBoundingClientRect().top + section.offsetHeight / 2;
        move(dragId, after ? draft.order[index + 1] ?? null : id);
      }
    });
    const title = document.createElement('strong'); title.textContent = labels[id];
    const enabledLabel = document.createElement('label');
    const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = draft.enabled[id];
    enabled.addEventListener('change', () => { draft.enabled[id] = enabled.checked; section.dataset.enabled = enabled.checked; changed(); });
    enabledLabel.append(enabled, ' Show');
    header.append(title, enabledLabel);
    for (const [text, offset] of [['Up', -1], ['Down', 1]]) {
      const button = document.createElement('button'); button.textContent = text; button.setAttribute('aria-label', `${labels[id]} ${text.toLowerCase()}`);
      button.disabled = index + offset < 0 || index + offset >= draft.order.length;
      button.addEventListener('click', () => {
        const order = [...draft.order]; [order[index], order[index + offset]] = [order[index + offset], order[index]];
        draft.order = order; drawSections(); changed();
      });
      header.append(button);
    }
    const fields = document.createElement('div'); fields.className = 'section-fields';
    if (id === 'heading') fields.append(field('title', 'Title'), field('name', 'Name'));
    else if (id !== 'bottom') fields.append(field(id, `${labels[id]} text (synthetic example)`, true));
    else {
      fields.append(selector('bottom', 'Content', [['joke', 'Joke'], ['sudoku', 'Sudoku'], ['art', 'Garden line art']]));
      if (draft.bottom === 'joke') fields.append(field('joke', 'Joke text', true));
      if (draft.bottom === 'sudoku') {
        fields.append(selector('difficulty', 'Difficulty', [['easy', 'Easy'], ['medium', 'Medium']]));
        const next = document.createElement('button'); next.textContent = 'New puzzle';
        next.addEventListener('click', () => { draft.seed = (draft.seed + 1) >>> 0; changed(); }); fields.append(next);
      }
    }
    section.append(header, fields); container.append(section);
  });
}
function changed() {
  synced = false;
  pending = true;
  $('#card').hidden = true;
  $('#render-status').textContent = 'Updating draft...';
  $('#metadata').textContent = '';
  clearApproval();
  clearTimeout(timer);
  timer = setTimeout(flush, 300);
}
async function flush() {
  if (sending || !pending) return;
  sending = true;
  pending = false;
  try {
    setState(await post('update_draft', { revision: state.revision, draft: structuredClone(draft) }));
    synced = !pending;
  } catch (failure) {
    error(failure.message);
    // Refresh only server metadata; never overwrite unsent field values.
    try { state = await (await fetch('state')).json(); } catch { error('Editor connection unavailable.'); }
  } finally { sending = false; if (pending) void flush(); else queueInspection(); }
}
async function stable() {
  clearTimeout(timer);
  await flush();
  if (sending || pending || !synced) throw new Error('Finish or correct the current edit before continuing.');
}
function clearApproval() {
  decodedId = null;
  $('#confirm').disabled = true;
  $('#approval').hidden = true;
}
function canConfirm() {
  const prepared = state?.prepared;
  return prepared && !prepared.claimed && prepared.approvalToken && decodedId === prepared.inspectionId &&
    prepared.target === $('#target').value.trim().toLowerCase() && prepared.revision === state.revision &&
    state.renderedRevision === state.revision && !pending && !sending && synced && !confirming && !inspecting &&
    !selecting && !scanRequest && !scanActive() &&
    prepared.health.bluetooth === 'ready' && !prepared.health.safety_blocked && !prepared.health.active_job_id &&
    !prepared.health.confirmation_preference_error;
}
function drawPrinting() {
  $('#printing').hidden = !state.printingAvailable;
  if (!state.printingAvailable) return;
  drawDiscovery();
  const prepared = state.prepared;
  if (!prepared || pending || !synced) clearApproval();
  else {
    $('#approval').hidden = false;
    if (inspectedId !== prepared.inspectionId) {
      inspectedId = prepared.inspectionId; decodedId = null;
      const bitmap = document.createElement('img'); bitmap.width = 384; bitmap.alt = 'Exact helper-produced printer bitmap';
      bitmap.addEventListener('load', () => {
        if (state.prepared?.inspectionId === prepared.inspectionId) {
          decodedId = prepared.inspectionId; $('#confirm').disabled = !canConfirm();
        }
      });
      bitmap.addEventListener('error', () => { decodedId = null; $('#confirm').disabled = true; error('Exact printer bitmap could not be displayed. Do not print.'); });
      bitmap.src = `print-preview.png?inspection=${prepared.inspectionId}`;
      $('#print-image').replaceChildren(bitmap);
    }
    $('#helper-state').textContent = `Helper: ${prepared.health.bluetooth}; confirmation mode: ${prepared.mode}. Estimated paper: ${prepared.estimatedPaperMm.toFixed(1)} mm.`;
    $('#print-binding').textContent = `Printer ${state.selectedPrinter?.name ?? 'selected device'} (${prepared.target.slice(-8)}) | Draft revision ${prepared.revision} | Original SHA-256 ${prepared.digest} | Job ${prepared.jobId}`;
    $('#print-ready').textContent = prepared.claimed ? 'Already sent or claimed. Check its status; this job will not print again.' :
      prepared.mode === 'ai_client' ? 'Ready when the exact bitmap has loaded. One Print click sends this card.' :
        'Native confirmation is on. Print will also require approval in the helper.';
    if (prepared.claimed) $('#helper-state').textContent += ' This intent is already claimed. Status only; no replay.';
    lastJobId = prepared.intent?.jobId ?? prepared.jobId;
  }
  if (state.job) {
    lastJobId = state.job.jobId;
    $('#job-status').textContent = `${state.job.state}: ${state.job.message ?? ''} Paper output is not confirmed by transport submission.`;
  }
  $('#confirm').disabled = !canConfirm();
  $('#status').disabled = !lastJobId || confirming;
}
function scanActive() { return ['scanning', 'stopping'].includes(state?.discovery?.state); }
function drawDiscovery() {
  const discovery = state.discovery ?? { state: 'idle', devices: [], message: 'Choose Scan for printers.' };
  const list = JSON.stringify(discovery.devices);
  if (list !== deviceList) {
    deviceList = list;
    const placeholder = document.createElement('option');
    placeholder.value = ''; placeholder.textContent = 'Select a discovered printer';
    $('#target').replaceChildren(placeholder);
    for (const device of discovery.devices) {
      let suffix = 8;
      while (suffix < 36 && discovery.devices.some(other => other.id !== device.id && other.id.slice(-suffix) === device.id.slice(-suffix))) suffix += 4;
      const option = document.createElement('option'); option.value = device.id;
      option.textContent = `${device.name} (${device.id.slice(-suffix)}, ${device.rssi === null ? 'signal unknown' : `${device.rssi} dBm`})`;
      $('#target').append(option);
    }
  }
  if (!selecting) $('#target').value = state.selectedPrinter?.id ?? '';
  $('#target').disabled = selecting || confirming || scanRequest || discovery.devices.length === 0;
  $('#scan-status').textContent = `${discovery.state}: ${discovery.message}`;
  $('#scan').disabled = scanRequest || confirming || scanActive();
  $('#stop-scan').disabled = scanRequest || confirming || !state.discovery?.scanId ||
    !['scanning', 'stopping', 'error'].includes(discovery.state);
  $('#inspect').disabled = inspecting || confirming || selecting || scanRequest || scanActive() || !$('#target').value;
}
async function scanOperation(name) {
  if (scanRequest || confirming) return;
  scanRequest = true;
  if (name === 'start_scan') { clearApproval(); state.prepared = null; attemptedInspectionKey = null; }
  drawDiscovery();
  try { setState(await post(name, {})); }
  catch (failure) { await resyncAfterFailure(failure); }
  finally { scanRequest = false; drawDiscovery(); queueInspection(); }
}
$('#scan').addEventListener('click', () => scanOperation('start_scan'));
$('#stop-scan').addEventListener('click', () => scanOperation('stop_scan'));
$('#target').addEventListener('change', async () => {
  clearApproval();
  attemptedInspectionKey = null;
  selecting = true;
  if (state) {
    state.prepared = null;
    try { setState(await post('select_printer', { id: $('#target').value })); }
    catch (failure) { error(failure.message); }
    finally { selecting = false; drawDiscovery(); queueInspection(); }
  }
});
function queueInspection() {
  clearTimeout(previewTimer);
  const target = $('#target').value?.trim().toLowerCase();
  if (!state?.printingAvailable || !targetPattern.test(target ?? '') || pending || sending || !synced ||
      confirming || inspecting || selecting || scanRequest || scanActive() ||
      state.renderedRevision !== state.revision || !state.image ||
      (state.prepared?.revision === state.revision && state.prepared.target === target) ||
      attemptedInspectionKey === `${state.revision}:${target}`) return;
  $('#print-ready').textContent = 'Preparing exact printer preview...';
  previewTimer = setTimeout(() => inspectForPrinting(), 500);
}
async function inspectForPrinting() {
  if (inspecting || confirming || selecting || scanRequest || scanActive()) return;
  if (!targetPattern.test($('#target').value?.trim().toLowerCase() ?? '')) {
    error('Select a printer before refreshing the print preview.');
    return;
  }
  inspecting = true; clearApproval(); $('#inspect').disabled = true;
  try {
    await stable();
    const target = $('#target').value.trim().toLowerCase();
    attemptedInspectionKey = `${state.revision}:${target}`;
    const result = await post('inspect_for_print', { revision: state.revision, target });
    if (target !== $('#target').value.trim().toLowerCase() || pending || sending || !synced) {
      await post('invalidate_print', {}); throw new Error('Draft or target changed. Inspect again.');
    }
    setState(result);
  } catch (failure) {
    error(failure.message);
    $('#print-ready').textContent = 'Print preview unavailable. Resolve the error, then refresh it.';
  } finally {
    inspecting = false; drawDiscovery();
    $('#confirm').disabled = !canConfirm();
    queueInspection();
  }
}
$('#inspect').addEventListener('click', () => inspectForPrinting());
$('#confirm').addEventListener('click', async event => {
  if (!event.isTrusted || !canConfirm()) return;
  const prepared = state.prepared;
  confirming = true; clearApproval();
  document.querySelectorAll('#sections input, #sections textarea, #sections select, #sections button, #target, #inspect').forEach(node => { node.disabled = true; });
  try {
    setState(await post('confirm_print', {
      revision: prepared.revision, jobId: prepared.jobId, target: prepared.target,
      digest: prepared.digest, bitmapDigest: prepared.bitmapDigest, inspectionId: prepared.inspectionId,
      approvalToken: prepared.approvalToken, paperApproved: true
    }));
  } catch (failure) {
    state.prepared = null;
    error(`${failure.message} Do not retry. Check the original job status.`);
  } finally {
    confirming = false;
    drawSections(); drawPrinting();
  }
});
async function checkJob(jobId) {
  try { setState(await post('get_print_status', { jobId })); }
  catch (failure) { error(failure.message); }
}
$('#status').addEventListener('click', () => { if (lastJobId) void checkJob(lastJobId); });
$('#history').addEventListener('click', async () => {
  try {
    const jobs = await post('list_prints', {});
    $('#job-choice').replaceChildren();
    for (const job of jobs) {
      const option = document.createElement('option'); option.value = job.jobId;
      option.textContent = `${job.jobId} | ${job.claimed ? 'Claimed, query receipt' : 'Not dispatched'}`;
      $('#job-choice').append(option);
    }
    $('#job-history').hidden = false; $('#recover').disabled = !jobs.length;
    $('#capacity').textContent = `${jobs.length} of 64 private intent slots used. Claimed jobs cannot be removed.`;
    $('#discard-intent').disabled = !jobs.length;
  } catch (failure) { error(failure.message); }
});
$('#recover').addEventListener('click', () => void checkJob($('#job-choice').value));
$('#discard-intent').addEventListener('click', async event => {
  const jobId = $('#job-choice').value;
  if (!event.isTrusted || !jobId || !window.confirm('Discard this unsubmitted intent and its cached images? Claimed jobs cannot be removed.')) return;
  try {
    await post('discard_unsubmitted', { jobId, confirmed: true });
    $('#job-history').hidden = true; clearApproval();
    setState(await (await fetch('state')).json());
  } catch (failure) { error(failure.message); }
});
for (const [id, copy] of [['save', false], ['copy', true]]) {
  $(`#${id}`).addEventListener('click', async () => {
    try { await stable(); setState(await post('save_draft', { revision: state.revision, copy })); $('#save-status').textContent = 'Saved privately on this Mac'; }
    catch (failure) { error(failure.message); }
  });
}
$('#browse').addEventListener('click', async () => {
  try {
    const records = await post('list_drafts', {});
    $('#draft-choice').replaceChildren();
    for (const record of records) {
      const option = document.createElement('option'); option.value = record.id; option.textContent = record.title;
      $('#draft-choice').append(option);
    }
    $('#saved-drafts').hidden = false; $('#open').disabled = !records.length;
    if (!records.length) error('No saved drafts yet. Save this draft first.');
  } catch (failure) { error(failure.message); }
});
$('#open').addEventListener('click', async () => {
  try {
    await stable();
    setState(await post('open_draft', { revision: state.revision, id: $('#draft-choice').value }));
    draft = structuredClone(state.draft); drawSections(); $('#saved-drafts').hidden = true;
  } catch (failure) { error(failure.message); }
});
$('#card').addEventListener('error', () => { $('#card').hidden = true; error('Preview could not be displayed. Edit again or reopen the panel.'); });
try {
  const response = await fetch('state');
  if (!response.ok) throw new Error('Editor unavailable.');
  setState(await response.json()); draft = structuredClone(state.draft); drawSections();
} catch (failure) { error(failure.message); }
let poll;
async function pollState() {
  if (!state || pending || sending || !synced || confirming || inspecting) return;
  try {
    let latest;
    if (scanActive() && !scanRequest) latest = await post('scan_status', {});
    else {
      const response = await fetch('state', { cache: 'no-store' });
      if (!response.ok) throw new Error('Editor connection unavailable.');
      latest = await response.json();
    }
    if (pending || sending || !synced || confirming || inspecting || selecting || scanRequest) return;
    if (latest.revision !== state.revision) {
      setState(latest); draft = structuredClone(latest.draft); drawSections();
    } else if (latest.renderedRevision !== state.renderedRevision || latest.image?.sha256 !== state.image?.sha256 ||
        latest.prepared?.inspectionId !== state.prepared?.inspectionId ||
        JSON.stringify(latest.discovery) !== JSON.stringify(state.discovery) ||
        latest.selectedPrinter?.id !== state.selectedPrinter?.id ||
        JSON.stringify(latest.job) !== JSON.stringify(state.job) ||
        JSON.stringify(latest.error) !== JSON.stringify(state.error)) setState(latest);
  } catch (failure) { await resyncAfterFailure(failure); }
}
function startPolling() { if (poll === undefined) poll = setInterval(pollState, 1000); }
startPolling();
window.addEventListener('pagehide', () => { clearInterval(poll); poll = undefined; clearTimeout(previewTimer); });
window.addEventListener('pageshow', startPolling);
