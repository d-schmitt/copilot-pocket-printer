const $ = selector => document.querySelector(selector);
let state, busy = false, currentState = false, epoch = 0, imageKey = null, decoded = null, attempted = null, poll;
let lastJobId = null, statusFailed = false, imageFailed = false, ticking = false, querying = false;
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
function job() { return state?.job?.jobId === lastJobId ? state?.job : null; }
function settled() { return ['submitted_only', 'cancelled_before_submission'].includes(job()?.state); }
function canFollowJob() {
  return settled() || (state?.prepared?.isCopy && job()?.state === 'rejected_before_admission');
}
function blocksPrint() {
  const receipt = job();
  return Boolean(lastJobId && !settled() && !receipt?.outcomeAcknowledged &&
    !['not_dispatched', 'rejected_before_admission'].includes(receipt?.state));
}
function canRepeat() {
  const p = state?.prepared;
  return currentState && visible() && !busy && !scanning() && !statusFailed && !state?.error &&
    state?.flow?.template === 'token-verbrauch' && p?.claimed && p.jobId === lastJobId && canFollowJob() &&
    p.target === state.selectedPrinter?.id && p.revision === state.revision && printableRevision();
}
function canPrint() {
  const p = state?.prepared;
  return currentState && visible() && !busy && !blocksPrint() &&
    !statusFailed && p && !p.claimed && p.approvalToken &&
    (coverOnly() || decoded === p.inspectionId) &&
    p.target === state.selectedPrinter?.id && p.revision === state.revision &&
    state.renderedRevision === state.revision && !state.error && !scanning() &&
    p.health.bluetooth === 'ready' && !p.health.safety_blocked && !p.health.active_job_id &&
    !p.health.confirmation_preference_error;
}
function controls() {
  const p = state?.prepared;
  const repeat = state?.flow?.template === 'token-verbrauch' && p?.claimed && p.jobId === lastJobId && canFollowJob();
  $('#print').textContent = repeat ? 'Noch einmal drucken' : coverOnly() ? 'Ohne Vorschau drucken' : 'Drucken';
  $('#print').lang = 'de';
  $('#print').disabled = repeat ? !canRepeat() : !canPrint();
  $('#print').hidden = Boolean(p?.claimed && !repeat) || blocksPrint();
  $('#scan').disabled = busy || scanning() || blocksPrint();
  $('#stop').hidden = !state?.discovery?.scanId || !['scanning', 'stopping', 'error'].includes(state.discovery.state);
  $('#stop').disabled = busy;
  $('#target').disabled = busy || blocksPrint() || !state?.discovery?.devices.length;
  $('#refresh').hidden = !state?.error && !imageFailed;
  $('#refresh').disabled = !currentState || !visible() || busy || scanning() || !state?.selectedPrinter || !printableRevision();
  $('#status').hidden = !lastJobId || !(statusFailed || job()?.state === 'uncertain' || state?.error);
  $('#status').disabled = busy;
  const jobState = job()?.state;
  const summary = !lastJobId ? '' : statusFailed || jobState === 'uncertain' ? 'Druck nicht bestätigt.' :
    ({
      submitted_only: 'An den Drucker übertragen.',
      awaiting_approval: 'Bestätigung im Drucker-Helfer nötig.',
      in_progress: 'Auftrag wird übertragen.',
      cancelling: 'Auftrag wird abgebrochen.',
      cancelled_before_submission: 'Vor der Übertragung abgebrochen.',
      rejected_before_admission: 'Auftrag nicht angenommen.',
      not_dispatched: 'Auftrag nicht gesendet.'
    }[jobState] ?? 'Druckstatus wird abgefragt.');
  $('#job').hidden = !summary;
  if ($('#job').textContent !== summary) $('#job').textContent = summary;
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
    ['label[for="target"]', 'Printer', 'Drucker']
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
    imageKey = key; decoded = null; imageFailed = false;
    $('#preview').replaceChildren();
    if (key) {
      const img = document.createElement('img');
      img.width = 384;
      img.alt = p ? 'Exact helper-produced printer bitmap' : 'Draft layout, not yet inspected for printing';
      img.addEventListener('load', () => {
        if (imageKey !== key) return;
        imageFailed = false; decoded = p?.inspectionId ?? null; controls();
      });
      img.addEventListener('error', () => {
        if (imageKey !== key) return;
        imageFailed = true; decoded = null; controls(); error('Die Druckvorschau konnte nicht geladen werden. Wiederhole die Vorbereitung unter Details.');
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
  if (p?.claimed && lastJobId !== p.jobId) { lastJobId = p.jobId; statusFailed = false; }
  else if (!lastJobId && value.job) lastJobId = value.job.jobId;
  $('#ready').textContent = p?.mode === 'native' ? 'Eine weitere Bestätigung im Drucker-Helfer ist nötig. Dort kann die Druckgrafik sichtbar sein.' :
    'Die Vorbereitung erfolgt automatisch. Ein Klick gibt nur einen Auftrag frei.';
  $('#job-detail').hidden = !job() && !value.error;
  $('#job-detail').textContent = [job() && `${job().jobId}: ${job().message ?? job().state}`, value.error?.message,
    job() && 'Die Übertragung bestätigt keine Papierausgabe. Eine Statusabfrage sendet nichts erneut.',
    settled() && p?.claimed && tokenCover && 'Ein weiterer Klick gibt eine neue Kopie frei.'].filter(Boolean).join(' ');
  error(value.error ? 'Der Druckvorgang konnte nicht abgeschlossen werden. Siehe Details.' :
    imageFailed ? 'Die Druckvorschau konnte nicht geladen werden. Wiederhole die Vorbereitung unter Details.' : '');
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
    $('#job-detail').hidden = false;
    $('#job-detail').textContent = failure.message;
    error('Die Aktion konnte nicht abgeschlossen werden. Siehe Details.');
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
async function updateStatus() {
  if (busy || querying || !lastJobId) return;
  querying = true;
  const id = lastJobId, generation = epoch;
  try {
    const updated = await request('get_print_status', { jobId: id });
    if (busy || epoch !== generation || lastJobId !== id) return;
    statusFailed = false;
    draw(updated);
  } catch (failure) {
    if (epoch !== generation || lastJobId !== id) return;
    statusFailed = true;
    controls();
    $('#job-detail').hidden = false;
    $('#job-detail').textContent = failure.message;
  } finally { querying = false; }
}
$('#status').addEventListener('click', updateStatus);
$('#print').addEventListener('keydown', event => {
  if (event.repeat && ['Enter', ' '].includes(event.key)) event.preventDefault();
});
$('#print').addEventListener('click', async event => {
  if (!event.isTrusted || event.detail > 1) return;
  if (canRepeat()) {
    const p = state.prepared;
    await operate('repeat_print', { revision: p.revision, target: p.target, jobId: p.jobId,
      inspectionId: p.inspectionId, paperApproved: true });
    return;
  }
  if (!canPrint()) return;
  const p = state.prepared;
  lastJobId = p.jobId;
  decoded = null;
  await operate('confirm_print', {
    revision: p.revision, jobId: p.jobId, target: p.target, digest: p.digest,
    bitmapDigest: p.bitmapDigest, inspectionId: p.inspectionId, approvalToken: p.approvalToken, paperApproved: true
  });
});
async function tick() {
  if (busy || ticking || querying) return;
  ticking = true;
  const generation = epoch;
  try {
    const value = await request(scanning() ? 'scan_status' : 'state', scanning() ? {} : undefined);
    if (busy || epoch !== generation) return;
    draw(value);
    await autoInspect();
    if (lastJobId && !settled() && !statusFailed && job()?.state !== 'uncertain' &&
        !['not_dispatched', 'rejected_before_admission'].includes(job()?.state)) await updateStatus();
  } catch (failure) {
    if (epoch !== generation) return;
    currentState = false; decoded = null; imageKey = null; controls(); error(failure.message);
  } finally { ticking = false; }
}
function start() { if (poll === undefined) poll = setInterval(tick, 750); }
await tick();
start();
window.addEventListener('pagehide', () => { clearInterval(poll); poll = undefined; epoch++; currentState = false; decoded = null; imageKey = null; controls(); });
window.addEventListener('pageshow', start);
