import { joinSession, createCanvas, CanvasError } from '@github/copilot-sdk/extension';
import { editorCanvas } from './editor.mjs';
import { Printing } from './printing.mjs';

await joinSession({ canvases: [
  createCanvas(editorCanvas(CanvasError, { printing: () => new Printing() }))
] });
