const $ = selector => document.querySelector(selector);
const labels = { heading: 'Name & title', day: 'Day & daylight', walk: 'Walk', meetings: 'Meetings', bottom: 'Joke / Sudoku / art' };
let state, draft, pending = false, sending = false, synced = true, timer, dragId;

function error(message) { $('#error').textContent = message; $('#error').hidden = !message; }
async function post(name, input) {
  const response = await fetch(name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? 'Editor request failed.');
  return result;
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
  } finally { sending = false; if (pending) void flush(); }
}
async function stable() {
  clearTimeout(timer);
  await flush();
  if (sending || pending || !synced) throw new Error('Finish or correct the current edit before continuing.');
}
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
  const poll = setInterval(async () => {
    if (pending || sending || !synced) return;
    try {
      const response = await fetch('state', { cache: 'no-store' });
      if (!response.ok) throw new Error('Editor connection unavailable.');
      const latest = await response.json();
      if (pending || sending || !synced) return;
      if (latest.revision !== state.revision) {
        setState(latest); draft = structuredClone(latest.draft); drawSections();
      }
    } catch (failure) { error(failure.message); }
  }, 1000);
  window.addEventListener('pagehide', () => clearInterval(poll));
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
