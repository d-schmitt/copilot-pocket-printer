const image = document.querySelector('#preview');
const errorBox = document.querySelector('#error');
const picker = document.querySelector('#file');
let revision = 0;
let localError = '';

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}
function render(state) {
  if (revision !== state.revision) {
    revision = state.revision;
    localError = '';
    image.src = `image.png?revision=${revision}`;
    image.height = state.height;
  }
  document.querySelector('#source').textContent = state.source;
  document.querySelector('#dimensions').textContent = `${state.width} x ${state.height} pixels | ${state.bytes.toLocaleString()} bytes`;
  document.querySelector('#paper').textContent = `Estimated paper length: ${state.estimatedPaperMm.toFixed(1)} mm`;
  showError(localError || (state.error ? `${state.error.message} Previous image retained.` : ''));
}
async function refresh() {
  try {
    const response = await fetch('state', { cache: 'no-store' });
    if (!response.ok) throw new Error('Preview is unavailable. Close and reopen this panel.');
    render(await response.json());
  } catch {
    showError('Preview connection unavailable. Close and reopen this panel.');
  }
}
picker.addEventListener('change', async () => {
  const file = picker.files[0];
  if (!file) return;
  picker.disabled = true;
  try {
    if (file.size > 1024 * 1024) throw new Error('PNG must be at most 1 MiB.');
    const response = await fetch('image', {
      method: 'POST', headers: { 'Content-Type': 'image/png' }, body: file
    });
    const state = await response.json();
    if (!response.ok) throw new Error(state.error.message);
    localError = '';
    render(state);
  } catch (error) {
    localError = `${error.message} Previous image retained.`;
    showError(localError);
  } finally { picker.disabled = false; picker.value = ''; }
});
image.addEventListener('error', () => {
  localError = 'This browser could not decode the PNG. Select a different image.';
  showError(localError);
});
await refresh();
// Poll metadata only, never re-read a local file or repeatedly transfer image bytes.
let timer = setInterval(refresh, 1000);
window.addEventListener('pagehide', () => { clearInterval(timer); timer = null; });
window.addEventListener('pageshow', () => { if (!timer) timer = setInterval(refresh, 1000); });
