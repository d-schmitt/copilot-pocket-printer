import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PreviewError } from './png.mjs';

export const fixedDigest = '7e958ac9eba14890d5ae6db761892527496885713e71a1df2410f54164cc67ea';

export async function renderFixedTemplate() {
  const image = await readFile(new URL('./template-raster.png', import.meta.url));
  if (createHash('sha256').update(image).digest('hex') !== fixedDigest) {
    throw new PreviewError('invalid_template_raster', 'The fixed template artwork did not pass its integrity check. No print is available.');
  }
  return image;
}
