import { joinSession, createCanvas, CanvasError } from '@github/copilot-sdk/extension';
import { previewCanvas } from './preview.mjs';
import { editorCanvas } from './editor.mjs';
import { Printing } from './printing.mjs';

await joinSession({ canvases: [
  createCanvas(previewCanvas(CanvasError)),
  createCanvas(editorCanvas(CanvasError, { printing: () => new Printing() }))
] });
