// Pictures for the target gallery: every target of public/targets/index.json, snapshot on white
// (src/model/Thumbnail.js) in a headless browser through the running dev server, saved as
// public/targets/thumbs/<target file name>.png; each entry gets its "thumb". Then the primitives
// (src/model/TargetMesh.js), at their "thumb". `primitives` after the server: only those.
//   npm run dev        (in another terminal)
//   npm run thumbs [-- http://localhost:5173]       needs Playwright: npx playwright install chromium
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright'); // a local or a global install

const root = fileURLToPath(new URL('../public/targets/', import.meta.url));
const base = process.argv.slice(2).find((a) => a.startsWith('http')) ?? 'http://localhost:5173';
const onlyPrimitives = process.argv.includes('primitives');
const list = JSON.parse(await readFile(`${root}index.json`, 'utf8'));
await mkdir(`${root}thumbs`, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.goto(`${base}/targets/index.json`);
for (const t of onlyPrimitives ? [] : list) {
  const png = await page.evaluate(async (url) => (await import('/src/model/Thumbnail.js')).snapshot(url), `/targets/${t.file}`);
  const name = `${t.file.split('/').filter((s) => s !== '..' && s !== 'model.glb').join('_').replace(/\.glb$/, '')}.png`;
  await writeFile(`${root}thumbs/${name}`, Buffer.from(png.split(',')[1], 'base64'));
  t.thumb = `thumbs/${name}`;
  console.log(t.name, '->', t.thumb);
}
const primitives = await page.evaluate(async () => {
  const [{ PRIMITIVES }, { snapshotGeometry }] = await Promise.all([import('/src/model/TargetMesh.js'), import('/src/model/Thumbnail.js')]);
  const out = [];
  for (const p of PRIMITIVES) out.push({ name: p.name, thumb: p.thumb, png: await snapshotGeometry(p.geometry()) });
  return out;
});
for (const { name, thumb, png } of primitives) {
  await writeFile(`${root}${thumb}`, Buffer.from(png.split(',')[1], 'base64'));
  console.log(name, '->', thumb);
}
await browser.close();
if (!onlyPrimitives) await writeFile(`${root}index.json`, `${JSON.stringify(list, null, 2)}\n`);
