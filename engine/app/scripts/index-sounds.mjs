#!/usr/bin/env node
/**
 * Indexes sample packs for the impact sounds: every audio file under public/sounds/collisions
 * and public/sounds/blasts is sorted by its path's words (folder names included), and the result
 * is written to public/sounds/bank.json, which the app reads (no bank: impacts are synthesised).
 *
 *   size   heavy  heavy, large, big, huge, massive, giant, deep, thick, low, bass, xl
 *          light  light, small, tiny, little, mini, high, xs, short
 *          medium medium, med, mid, normal, moderate, or no hint
 *   shape  sheet  sheet, plate, foil, panel, tin, can, lid, thin, corrugated, roof; else solid
 *   blast  explosion, explode, boom, blast, detonation, crunch (in blasts/ anyway)
 * The app then plays a part's hit from its shape and its mass class (light < 0.12 kg <= medium
 * < 0.75 kg <= heavy, about the quartiles of the eight models' parts).
 *
 *   npm run sounds            (from engine/app)
 */
import { readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sounds');
const AUDIO = new Set(['.ogg', '.wav', '.mp3', '.flac', '.m4a', '.opus', '.webm', '.aac']);
const WORDS = {
  heavy: ['heavy', 'large', 'big', 'huge', 'massive', 'giant', 'deep', 'thick', 'low', 'bass', 'xl', 'xxl'],
  light: ['light', 'small', 'tiny', 'little', 'mini', 'high', 'xs', 'short'],
  medium: ['medium', 'med', 'mid', 'normal', 'moderate', 'average'],
  sheet: ['sheet', 'sheets', 'plate', 'plates', 'foil', 'panel', 'panels', 'tin', 'can', 'cans', 'lid', 'thin', 'corrugated', 'roof', 'sheetmetal'],
  blast: ['explosion', 'explosions', 'explode', 'boom', 'blast', 'blasts', 'detonation', 'crunch'],
};

/** The words of a path: split on separators, digits and camelCase, lower case. */
export function words(path) {
  return path
    .replace(extname(path), '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** { blast } or { shape: 'solid' | 'sheet', size: 'heavy' | 'medium' | 'light' } from a file's path. */
export function classify(path) {
  const w = words(path);
  const has = (list) => w.some((x) => list.includes(x));
  if (has(WORDS.blast) || w[0] === 'blasts') return { blast: true };
  const shape = has(WORDS.sheet) ? 'sheet' : 'solid';
  const size = has(WORDS.heavy) ? 'heavy' : has(WORDS.light) ? 'light' : 'medium';
  return { shape, size };
}

function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : AUDIO.has(extname(name).toLowerCase()) ? [path] : [];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bank = { about: 'Written by scripts/index-sounds.mjs: impacts by shape and mass class, from file names.', impacts: {}, boom: [] };
  for (const shape of ['solid', 'sheet']) bank.impacts[shape] = { heavy: [], medium: [], light: [] };
  for (const path of [...files(join(ROOT, 'collisions')), ...files(join(ROOT, 'blasts'))]) {
    const file = relative(ROOT, path).split('\\').join('/');
    const c = classify(file);
    if (c.blast) bank.boom.push(file);
    else bank.impacts[c.shape][c.size].push(file);
  }
  writeFileSync(join(ROOT, 'bank.json'), `${JSON.stringify(bank, null, 2)}\n`);
  const count = (s) => Object.entries(bank.impacts[s]).map(([k, v]) => `${k} ${v.length}`).join(', ');
  console.log(`public/sounds/bank.json: solid (${count('solid')}), sheet (${count('sheet')}), blasts ${bank.boom.length}`);
}
