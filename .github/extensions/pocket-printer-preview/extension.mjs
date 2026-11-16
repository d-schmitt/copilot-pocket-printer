import { joinSession, createCanvas, CanvasError } from '@github/copilot-sdk/extension';
import { previewCanvas } from './preview.mjs';
import { editorCanvas } from './editor.mjs';
import { Printing } from './printing.mjs';

// Keep the editor usable while the new print-capable boundary awaits separate activation approval.
const enablePrinting = false;
await joinSession({ canvases: [
  createCanvas(previewCanvas(CanvasError)),
  createCanvas(editorCanvas(CanvasError, enablePrinting ? { printing: () => new Printing() } : {}))
] });
