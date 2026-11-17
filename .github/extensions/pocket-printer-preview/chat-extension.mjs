import { joinSession, createCanvas, CanvasError } from '@github/copilot-sdk/extension';
import { chatCanvas } from './chat.mjs';
import { Printing } from './printing.mjs';

await joinSession({ canvases: [
  createCanvas(chatCanvas(CanvasError, { printing: () => new Printing() }))
] });
