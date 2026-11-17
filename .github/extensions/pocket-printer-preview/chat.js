const $ = selector => document.querySelector(selector);
let state, busy = false, epoch = 0, imageKey = null, decoded = null, attempted = null, lastJobId = null, poll;
function error(message) { $('#error').textContent = message; $('#error').hidden = !message; }
async function request(route, input) {
  const response = await fetch(route, input === undefined ? { cache: 'no-store' } :
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? 'The canvas connection failed.');
  return result;
}
function scanning() { return ['scanning', 'stopping'].includes(state?.discovery?.state); }
function canPrint() {
  const p = state?.prepared;
  return !busy && p && !p.claimed && p.approvalToken && decoded === p.inspectionId &&
    p.target === state.selectedPrinter?.id && p.revision === state.revision &&
    state.renderedRevision === state.revision && !state.error && !scanning() &&
    p.health.bluetooth === 'ready' && !p.health.safety_blocked && !p.health.active_job_id &&
    !p.health.confirmation_preference_error;
}
function controls() {
  $('#print').disabled = !canPrint();
  $('#scan').disabled = busy || scanning();
  $('#stop').hidden = !state?.discovery?.scanId || !['scanning', 'stopping', 'error'].includes(state.discovery.state);
  $('#stop').disabled = busy;
  $('#target').disabled = busy || !state?.discovery?.devices.length;
  $('#refresh').disabled = busy || scanning() || !state?.selectedPrinter || !state.image || state.renderedRevision !== state.revision;
  $('#status').hidden = !lastJobId;
  $('#status').disabled = busy;
}
function draw(value) {
  if (state && value.revision < state.revision) return;
  state = value;
  const valid = value.image && value.renderedRevision === value.revision;
  const p = valid ? value.prepared : null;
  const key = p ? `exact:${p.inspectionId}` : valid ? `draft:${value.revision}:${value.image.sha256}` : null;
  if (key !== imageKey) {
    imageKey = key; decoded = null;
    $('#preview').replaceChildren();
    if (key) {
      const img = document.createElement('img');
      img.width = 384;
      img.alt = p ? 'Exact helper-produced printer bitmap' : 'Draft layout, not yet inspected for printing';
      img.addEventListener('load', () => {
        if (imageKey !== key) return;
        decoded = p?.inspectionId ?? null; controls();
      });
      img.addEventListener('error', () => {
        if (imageKey !== key) return;
        decoded = null; controls(); error('The current bitmap could not be displayed. Refresh the preview before printing.');
      });
      img.src = p ? `print-preview.png?inspection=${p.inspectionId}` : `image.png?revision=${value.revision}`;
      $('#preview').append(img);
    }
  }
  $('#preview-status').textContent = p ? 'Exact print preview' :
    valid ? 'Draft preview. Select a printer to prepare the exact bitmap.' :
      value.rendering ? 'Rendering the latest chat revision...' : 'No printable preview. Describe or revise your content in chat.';
  $('#metadata').textContent = valid
    ? `384 x ${value.image.height} dots | Estimated paper: ${(p?.estimatedPaperMm ?? value.image.estimatedPaperMm).toFixed(1)} mm, including 80-dot feed. Length is approximate.`
    : '';
  const placeholder = document.createElement('option');
  placeholder.value = ''; placeholder.textContent = 'Select a discovered printer';
  $('#target').replaceChildren(placeholder);
  for (const device of value.discovery.devices) {
    const option = document.createElement('option');
    option.value = device.id;
    let suffix = 8;
    while (suffix < 36 && value.discovery.devices.some(other => other.id !== device.id && other.id.slice(-suffix) === device.id.slice(-suffix))) suffix += 4;
    option.textContent = `${device.name} (${device.id.slice(-suffix)})`;
    $('#target').append(option);
  }
  $('#target').value = value.selectedPrinter?.id ?? '';
  $('#scan-status').textContent = value.discovery.message;
  $('#ready').textContent = p?.claimed ? 'Already claimed. Check its status; this image will not be sent again.' :
    p ? p.mode === 'ai_client' ? 'Print sends the displayed bitmap to the selected printer.' :
      'Native confirmation is on. Print also requires approval in the helper.' : '';
  if (p) lastJobId = p.jobId;
  if (value.job) {
    lastJobId = value.job.jobId;
    $('#job').textContent = `${value.job.state}: ${value.job.message ?? ''} Transport submission does not confirm paper output.`;
  }
  error(value.error?.message ?? '');
  controls();
}
async function operate(route, input) {
  if (busy) return;
  busy = true; epoch++; controls();
  try { draw(await request(route, input)); }
  catch (failure) {
    decoded = null; imageKey = null;
    try { draw(await request('state')); }
    catch { error('The canvas connection is unavailable. Reopen this document; do not retry an uncertain print.'); return; }
    error(failure.message);
  } finally { busy = false; controls(); }
}
async function inspect() {
  if (busy || scanning() || !state?.selectedPrinter || !state.image || state.renderedRevision !== state.revision) return;
  attempted = `${state.revision}:${state.selectedPrinter.id}`;
  decoded = null;
  // A refresh replaces even a failed image element, so a genuine new load is required.
  imageKey = null;
  await operate('inspect_for_print', { revision: state.revision, target: state.selectedPrinter.id });
}
async function autoInspect() {
  if (state?.selectedPrinter && !state.prepared && !state.error &&
      attempted !== `${state.revision}:${state.selectedPrinter.id}`) await inspect();
}
$('#scan').addEventListener('click', async () => {
  decoded = null; attempted = null;
  await operate('start_scan', {});
});
$('#stop').addEventListener('click', () => operate('stop_scan', {}));
$('#target').addEventListener('change', async () => {
  const id = $('#target').value;
  decoded = null; attempted = null;
  await operate('select_printer', { id });
  await autoInspect();
});
$('#refresh').addEventListener('click', inspect);
$('#status').addEventListener('click', () => operate('get_print_status', { jobId: lastJobId }));
$('#print').addEventListener('click', async event => {
  if (!event.isTrusted || !canPrint()) return;
  const p = state.prepared;
  decoded = null;
  await operate('confirm_print', {
    revision: p.revision, jobId: p.jobId, target: p.target, digest: p.digest,
    bitmapDigest: p.bitmapDigest, inspectionId: p.inspectionId, approvalToken: p.approvalToken, paperApproved: true
  });
});
async function tick() {
  if (busy) return;
  const generation = epoch;
  try {
    const value = await request(scanning() ? 'scan_status' : 'state', scanning() ? {} : undefined);
    if (busy || epoch !== generation) return;
    draw(value);
    await autoInspect();
  } catch (failure) {
    if (epoch !== generation) return;
    decoded = null; imageKey = null; controls(); error(failure.message);
  }
}
function start() { if (poll === undefined) poll = setInterval(tick, 750); }
await tick();
start();
window.addEventListener('pagehide', () => { clearInterval(poll); poll = undefined; epoch++; decoded = null; imageKey = null; controls(); });
window.addEventListener('pageshow', start);
