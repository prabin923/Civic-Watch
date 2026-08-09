import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const extension = (mimeType) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mimeType] || 'img');

export function normalizePlate(value = '') {
  return String(value).normalize('NFKC').toUpperCase().replace(/[^A-Z0-9\u0900-\u097F]/g, '');
}

// Local-only helper for authorized in-memory analysis. It never stores the image
// and is intentionally not used for remote provider calls.
export async function readPlateLocally(image, mimeType) {
  if (!Buffer.isBuffer(image) || !image.length) return { available: false, rawText: '', normalizedPlate: '', confidence: null, engine: 'tesseract' };
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'civicwatch-plate-'));
    const source = join(directory, `plate.${extension(mimeType)}`);
    await writeFile(source, image);
    const command = process.env.LOCAL_TESSERACT_COMMAND || 'tesseract';
    const languages = process.env.LOCAL_TESSERACT_LANGUAGES || 'eng';
    const { stdout } = await execFile(command, [source, 'stdout', '-l', languages, '--psm', '7'], { timeout: 15_000, maxBuffer: 256 * 1024, windowsHide: true });
    const rawText = String(stdout || '').replace(/\s+/g, ' ').trim();
    return { available: true, rawText, normalizedPlate: normalizePlate(rawText), confidence: null, engine: 'tesseract', languages: languages.split('+') };
  } catch (error) {
    return { available: error?.code !== 'ENOENT', rawText: '', normalizedPlate: '', confidence: null, engine: 'tesseract', error: error?.code === 'ENOENT' ? 'not_installed' : 'unreadable' };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
