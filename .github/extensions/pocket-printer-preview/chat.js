const $ = selector => document.querySelector(selector);
let state, busy = false, currentState = false, epoch = 0, imageKey = null, decoded = null, attempted = null, lastJobId = null, poll;
function error(message) { $('#error').textContent = message; $('#error').hidden = !message; }
async function request(route, input) {
  const response = await fetch(route, input === undefined ? { cache: 'no-store' } :
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? 'The canvas connection failed.');
  return result;
}
function scanning() { return ['scanning', 'stopping'].includes(state?.discovery?.state); }
function visible() { return (!state?.flow || state.flow.view === 'preview') && !state?.flow?.hidden && !state?.flow?.pendingReplacement; }
function coverOnly() { return ['vortragsnotiz', 'token-verbrauch'].includes(state?.flow?.template); }
function printableRevision() { return state?.renderedRevision === state?.revision && (coverOnly() || Boolean(state?.image)); }
function canPrint() {
  const p = state?.prepared;
  return currentState && visible() && !busy && p && !p.claimed && p.approvalToken &&
    (coverOnly() || decoded === p.inspectionId) &&
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
  $('#refresh').disabled = !currentState || !visible() || busy || scanning() || !state?.selectedPrinter || !printableRevision();
  $('#status').hidden = !lastJobId;
  $('#status').disabled = busy;
  for (const id of [...galleryTemplates.map(template => `template-${template}`), 'back', 'resume', 'save-replace', 'replace', 'cancel-replace']) {
    $(`#${id}`).disabled = busy;
  }
  $('#reveal').disabled = busy || state?.renderedRevision !== state?.revision;
}
function draw(value) {
  if (state && value.revision < state.revision) return;
  const previousRequest = state?.flow?.pendingReplacement?.requestId;
  state = value;
  currentState = true;
  const flow = value.flow ?? { view: 'preview', hidden: false };
  const pending = flow.pendingReplacement;
  const cover = coverOnly();
  $('#gallery').hidden = flow.view !== 'gallery' || Boolean(pending);
  $('#resume').hidden = !value.document;
  $('#card-view').hidden = flow.view !== 'preview' || Boolean(pending);
  $('#replacement').hidden = !pending;
  $('#surprise-cover').hidden = !flow.hidden;
  const tokenCover = flow.template === 'token-verbrauch';
  $('#note-cover').hidden = flow.template !== 'vortragsnotiz';
  $('#token-cover').hidden = !tokenCover;
  $('#preview-section').hidden = Boolean(flow.hidden) || cover;
  $('#printer-section').hidden = Boolean(flow.hidden);
  $('#chat-hint').hidden = cover;
  for (const [selector, english, german] of [
    ['#back', 'Back to templates', 'Zurück zu den Vorlagen'],
    ['#scan', 'Find printer', 'Drucker finden'],
    ['#stop', 'Stop scan', 'Suche stoppen'],
    ['label[for="target"]', 'Printer', 'Drucker'],
    ['#print', 'Print', tokenCover ? 'Demo ohne Vorschau drucken' : 'Notiz ohne Vorschau drucken'],
    ['#refresh', 'Refresh preview', 'Druck vorbereiten'],
    ['#status', 'Check print status', 'Druckstatus prüfen']
  ]) {
    const element = $(selector);
    element.textContent = cover ? german : english;
    element.lang = cover ? 'de' : 'en';
  }
  $('#chat-hint').textContent = flow.template === 'focus' ? 'Tell Copilot your three priorities to fill these lines.' :
    flow.template === 'daily' ? 'Original daily layout. Supply your calendar and weather through chat; the starting card is a labelled synthetic example.' :
      flow.template === 'surprise' ? 'Chat edits reroll the Surprise and hide it again.' : 'Ask in chat to change this card.';
  $('#saved-notice').hidden = !flow.lastSavedDraft;
  $('#saved-notice').textContent = flow.lastSavedDraft ? 'Saved privately as a draft. Ask in chat to reopen saved drafts.' : '';
  const valid = visible() && !cover && value.image && value.renderedRevision === value.revision;
  const p = visible() && printableRevision() ? value.prepared : null;
  const key = !valid ? null : p ? `exact:${p.inspectionId}` : `draft:${value.revision}:${value.image.sha256}`;
  if (key !== imageKey || !valid) {
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
  placeholder.value = ''; placeholder.textContent = cover ? 'Gefundenen Drucker auswählen' : 'Select a discovered printer';
  placeholder.lang = cover ? 'de' : 'en';
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
  const idleCover = cover && value.discovery.state === 'idle';
  $('#scan-status').textContent = idleCover ? 'Suche nach kompatiblen Bluetooth-Druckern.' : value.discovery.message;
  $('#scan-status').lang = idleCover ? 'de' : 'en';
  $('#ready').lang = cover ? 'de' : 'en';
  $('#ready').textContent = cover ?
    p?.claimed ? 'Auftrag bereits erfasst. Prüfe den Druckstatus. Er wird nicht erneut gesendet.' :
      p?.mode === 'native' ? 'Im Drucker-Helfer ist eine weitere Bestätigung nötig. Dort kann die Druckgrafik sichtbar sein.' : '' :
    p?.claimed ? 'Already claimed. Check its status; this image will not be sent again.' :
    p ? p.mode === 'ai_client' ? 'Print sends the displayed bitmap to the selected printer.' :
      'Native confirmation is on. Print also requires approval in the helper.' : '';
  if (p) lastJobId = p.jobId;
  if (value.job) {
    lastJobId = value.job.jobId;
    $('#job').textContent = `${value.job.state}: ${value.job.message ?? ''} Transport submission does not confirm paper output.`;
  }
  error(value.error?.message ?? '');
  controls();
  if (pending && pending.requestId !== previousRequest) $('#save-replace').focus();
  else if (previousRequest && !pending) $('#back').focus();
}
async function operate(route, input) {
  if (busy) return;
  busy = true; epoch++; controls();
  try { draw(await request(route, input)); }
  catch (failure) {
    currentState = false; decoded = null; imageKey = null;
    try { draw(await request('state')); }
    catch { error('The canvas connection is unavailable. Reopen this document; do not retry an uncertain print.'); return; }
    error(failure.message);
  } finally { busy = false; controls(); }
}
async function inspect() {
  if (!currentState || !visible() || busy || scanning() || !state?.selectedPrinter || !printableRevision()) return;
  attempted = `${state.revision}:${state.selectedPrinter.id}`;
  decoded = null;
  // A refresh replaces even a failed image element, so a genuine new load is required.
  imageKey = null;
  await operate('inspect_for_print', { revision: state.revision, target: state.selectedPrinter.id });
}
async function autoInspect() {
  if (visible() && state?.selectedPrinter && !state.prepared && !state.error &&
      attempted !== `${state.revision}:${state.selectedPrinter.id}`) await inspect();
}
const galleryTemplates = ['daily', 'focus', 'vortragsnotiz', 'token-verbrauch'];
for (const template of galleryTemplates) {
  $(`#template-${template}`).addEventListener('click', () =>
    operate('request_template', { revision: state.revision, template }));
}
$('#back').addEventListener('click', async () => {
  decoded = null; imageKey = null; attempted = null;
  await operate('back_to_templates', {});
});
$('#resume').addEventListener('click', () => operate('resume_preview', {}));
$('#reveal').addEventListener('click', async event => {
  if (!event.isTrusted) return;
  attempted = null;
  await operate('reveal_preview', { revision: state.revision });
  await autoInspect();
});
for (const [id, decision] of [['save-replace', 'save'], ['replace', 'replace'], ['cancel-replace', 'cancel']]) {
  $(`#${id}`).addEventListener('click', async event => {
    if (!event.isTrusted || !state?.flow?.pendingReplacement) return;
    attempted = null; decoded = null;
    await operate('resolve_replacement', { requestId: state.flow.pendingReplacement.requestId, decision });
    await autoInspect();
  });
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
    currentState = false; decoded = null; imageKey = null; controls(); error(failure.message);
  }
}
function start() { if (poll === undefined) poll = setInterval(tick, 750); }
await tick();
start();
window.addEventListener('pagehide', () => { clearInterval(poll); poll = undefined; epoch++; currentState = false; decoded = null; imageKey = null; controls(); });
window.addEventListener('pageshow', start);
