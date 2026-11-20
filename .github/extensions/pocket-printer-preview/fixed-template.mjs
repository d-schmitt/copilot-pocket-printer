import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PreviewError } from './png.mjs';

const rasters = new Map([
  ['vortragsnotiz', ['template-raster.png', '7e958ac9eba14890d5ae6db761892527496885713e71a1df2410f54164cc67ea']],
  ['token-verbrauch', ['token-raster.png', '5e5167d20bf16345f3939000e8fe660104d6c3cc123d7dae32b02dac08b51119']]
]);
export const fixedTemplateNames = Object.freeze([...rasters.keys()]);
export const fixedDigest = name => rasters.get(name)?.[1];

export async function renderFixedTemplate(name) {
  const entry = rasters.get(name);
  if (!entry) throw new PreviewError('unknown_template', 'This template has no fixed print artwork.');
  const [file, digest] = entry;
  const image = await readFile(new URL(file, import.meta.url));
  if (createHash('sha256').update(image).digest('hex') !== digest) {
    throw new PreviewError('invalid_template_raster', 'The fixed template artwork did not pass its integrity check. No print is available.');
  }
  return image;
}
