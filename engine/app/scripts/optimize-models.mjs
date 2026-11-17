// Shrinks the baked models in public/models/<name>/ for the web, in place (run after physbake):
//   model.glb   textures as WebP, colour at most 1024 px, the others 512; each part's mesh simplified (meshoptimizer: at
//               most `ratio` of its triangles, within `error` of its size) then quantized and
//               compressed (EXT_meshopt_compression: three's GLTFLoader needs its MeshoptDecoder)
//   shapes.bin  gzipped to shapes.bin.gz (the manifest's "data" follows; Assembly.load inflates it)
// Node names (one per part) are kept: the app matches meshes to parts by them. A model done
// already (meshopt in its GLB, a .gz in its manifest) is left as it is.
//   npm run optimize-models [-- mecha_01 mecha_02 …]        (default: every model of index.json)
import { readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, simplify, textureCompress, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../public/models/', import.meta.url));
const SIZE = 1024; // px: the largest side of the colour texture
const OTHER_SIZE = 512; // px: of the others (metal/roughness, normals…)
const QUALITY = 82; // WebP
const RATIO = 0.5; // at most this share of a mesh's triangles kept…
const ERROR = 0.004; // …as long as the surface moves less than this share of the mesh's size

const names = process.argv.slice(2).length ? process.argv.slice(2) : JSON.parse(await readFile(`${root}index.json`, 'utf8'));
await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const mb = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`;

for (const name of names) {
  const dir = `${root}${name}/`;
  const manifest = JSON.parse(await readFile(`${dir}manifest.json`, 'utf8'));
  const glb = `${dir}${manifest.render?.url ?? 'model.glb'}`;
  const before = (await stat(glb)).size;
  const doc = await io.read(glb);
  if (doc.getRoot().listExtensionsUsed().some((e) => e.extensionName === 'EXT_meshopt_compression')) {
    console.log(`${name}: model.glb done already`);
  } else {
    await doc.transform(
      dedup(),
      prune({ keepLeaves: true, keepAttributes: true }),
      weld(),
      simplify({ simplifier: MeshoptSimplifier, ratio: RATIO, error: ERROR }),
      textureCompress({ encoder: sharp, targetFormat: 'webp', quality: QUALITY, resize: [SIZE, SIZE], slots: /^baseColor/ }),
      textureCompress({ encoder: sharp, targetFormat: 'webp', quality: QUALITY, resize: [OTHER_SIZE, OTHER_SIZE], slots: /^(?!baseColor)/ }),
      meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
    );
    await io.write(glb, doc);
    console.log(`${name}: model.glb ${mb(before)} -> ${mb((await stat(glb)).size)}`);
  }
  if (!manifest.data.endsWith('.gz')) {
    const data = await readFile(`${dir}${manifest.data}`);
    await writeFile(`${dir}${manifest.data}.gz`, gzipSync(data, { level: 9 }));
    await unlink(`${dir}${manifest.data}`);
    console.log(`${name}: ${manifest.data} ${mb(data.length)} -> ${mb((await stat(`${dir}${manifest.data}.gz`)).size)}`);
    manifest.data = `${manifest.data}.gz`;
    await writeFile(`${dir}manifest.json`, JSON.stringify(manifest));
  }
}
