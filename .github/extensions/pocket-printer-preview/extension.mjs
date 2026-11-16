import { joinSession, createCanvas, CanvasError } from '@github/copilot-sdk/extension';
import { previewCanvas } from './preview.mjs';

await joinSession({ canvases: [createCanvas(previewCanvas(CanvasError))] });
