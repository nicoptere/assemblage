import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/**
 * A picture of a GLB on white, for the target gallery: its meshes (lines and points skipped;
 * untextured ones in grey clay), lit by a studio environment, seen from the front-right and a
 * little above, framed to fill the square. Resolves to a PNG data URL. Used by
 * scripts/thumbs.mjs, which saves the pictures next to the targets (the primitives' too).
 */
export async function snapshot(url, options) {
  return snapshotObject((await new GLTFLoader().loadAsync(url)).scene, options);
}

/** The same picture of a three.js geometry, in grey clay (a primitive's); the geometry is disposed of. */
export async function snapshotGeometry(geometry, options) {
  const png = await snapshotObject(new THREE.Mesh(geometry), options);
  geometry.dispose();
  return png;
}

/** The same picture of any object (an uploaded mesh), which is left as it is. */
export async function snapshotObject(object, { size = 384, azimuth = 0.55, elevation = 0.3, fov = 28 } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(2, 4, 3);
  scene.add(sun);

  const clay = new THREE.MeshStandardMaterial({ color: 0x6c7480, roughness: 0.5, metalness: 0.2, side: THREE.DoubleSide });
  const shown = object.clone(); // a shallow copy: geometries and textures shared, materials swapped on it only
  const drop = [];
  shown.traverse((o) => {
    if (o.isLine || o.isPoints) drop.push(o);
    else if (o.isMesh && !o.material?.map) o.material = clay;
  });
  for (const o of drop) o.removeFromParent();
  scene.add(shown);

  const box = new THREE.Box3().setFromObject(shown);
  const centre = box.getCenter(new THREE.Vector3());
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
  const camera = new THREE.PerspectiveCamera(fov, 1, radius / 100, radius * 100);
  const distance = radius / Math.sin(THREE.MathUtils.degToRad(fov / 2)) * 0.92;
  camera.position.set(
    centre.x + distance * Math.sin(azimuth) * Math.cos(elevation),
    centre.y + distance * Math.sin(elevation),
    centre.z + distance * Math.cos(azimuth) * Math.cos(elevation),
  );
  camera.lookAt(centre);
  renderer.render(scene, camera);
  const png = renderer.domElement.toDataURL('image/png');
  pmrem.dispose();
  clay.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
  return png;
}
