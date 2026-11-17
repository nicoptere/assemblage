import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Assembly } from '../src/index.js';

/** Loads a physbake output folder from disk (Node). Returns null if it does not exist. */
export function loadAssemblyFromDisk(dir) {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const file = readFileSync(join(dir, manifest.data));
  const bin = manifest.data.endsWith('.gz') ? gunzipSync(file) : file; // gzipped by the app's optimize-models
  return new Assembly(manifest, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
}
