// Optimise Higgsfield GLBs for the game: orient to +Z, ground at y=0, scale to metres, (creased) normals,
// simplify, WebP textures, meshopt compression. Prints anchor metrics used for placement in-game.
// usage: node process.mjs <config.json> [name...]
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplify, textureCompress, meshopt, prune, dedup, transformMesh } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import * as THREE from 'three';
import { toCreasedNormals, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

await MeshoptEncoder.ready; await MeshoptSimplifier.ready; await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const [, , cfgFile, ...only] = process.argv;
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
const RAW = path.resolve(path.dirname(cfgFile), cfg.rawDir), OUT = path.resolve(path.dirname(cfgFile), cfg.outDir);
fs.mkdirSync(OUT, { recursive: true });

function triCount(doc) { let t = 0; for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) { const i = p.getIndices(); t += (i ? i.getCount() : p.getAttribute('POSITION').getCount()) / 3; } return t; }

/* creased normals (smooth across UV seams, hard above the crease angle), then re-index */
function creaseNormals(doc, angleDeg) {
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION'), uv = prim.getAttribute('TEXCOORD_0'), idx = prim.getIndices();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos.getArray()), 3));
    if (uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv.getArray()), 2));
    if (idx) g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx.getArray()), 1));
    let c = toCreasedNormals(g, angleDeg * Math.PI / 180);
    c = mergeVertices(c, 1e-6);
    const nPos = doc.createAccessor().setType('VEC3').setArray(new Float32Array(c.attributes.position.array));
    const nNor = doc.createAccessor().setType('VEC3').setArray(new Float32Array(c.attributes.normal.array));
    prim.setAttribute('POSITION', nPos).setAttribute('NORMAL', nNor);
    if (uv) prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(c.attributes.uv.array)));
    prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(c.index.array)));
  }
}

function allPositions(doc) {
  const out = [];
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) { const a = p.getAttribute('POSITION').getArray(); for (let i = 0; i < a.length; i += 3) out.push([a[i], a[i + 1], a[i + 2]]); }
  return out;
}
const r3 = v => v.map(x => +x.toFixed(3));
function metrics(doc) {
  const P = allPositions(doc), b = getBounds(doc.getRoot().listScenes()[0]);
  const m = { min: r3(b.min), max: r3(b.max) };
  // outermost lateral clusters (hands hanging at the sides) and the most forward point (fingertips / nose)
  const xr = b.max[0] - b.min[0];
  const sideL = P.filter(p => p[0] > b.max[0] - xr * 0.12), sideR = P.filter(p => p[0] < b.min[0] + xr * 0.12);
  const lowC = arr => { if (!arr.length) return null; const ymin = Math.min(...arr.map(p => p[1])); const s = arr.filter(p => p[1] < ymin + 0.1); return r3([0, 1, 2].map(k => s.reduce((a, p) => a + p[k], 0) / s.length)); };
  m.handPlusX = lowC(sideL); m.handMinusX = lowC(sideR);
  const fz = P.reduce((a, p) => (p[2] > a[2] ? p : a), [0, 0, -1e9]); m.front = r3(fz);
  // head top near the vertical axis
  const axis = P.filter(p => Math.abs(p[0]) < xr * 0.12); if (axis.length) m.topAxis = +Math.max(...axis.map(p => p[1])).toFixed(3);
  return m;
}

for (const it of cfg.models) {
  if (only.length && !only.includes(it.name)) continue;
  const doc = await io.read(path.join(RAW, it.in));
  const root = doc.getRoot();
  // Tripo and SAM exports are one node with an identity transform, so the mesh data can be edited directly
  const t0 = triCount(doc);
  // 1) orientation
  const rot = new THREE.Matrix4().makeRotationY((it.rotY || 0) * Math.PI / 180);
  if (it.rotX) rot.premultiply(new THREE.Matrix4().makeRotationX(it.rotX * Math.PI / 180));
  if (it.rotZ) rot.premultiply(new THREE.Matrix4().makeRotationZ(it.rotZ * Math.PI / 180));
  for (const mesh of root.listMeshes()) transformMesh(mesh, rot.elements);
  // 2) scale to target height (or longest side), ground at y=0, centre x/z
  let b = getBounds(root.listScenes()[0]);
  const size = [0, 1, 2].map(k => b.max[k] - b.min[k]);
  const s = it.height ? it.height / size[1] : it.longest ? it.longest / Math.max(...size) : 1;
  const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  const ground = it.center ? (b.min[1] + b.max[1]) / 2 : b.min[1];
  const tm = new THREE.Matrix4().makeScale(s, s, s).multiply(new THREE.Matrix4().makeTranslation(-cx, -ground, -cz));
  for (const mesh of root.listMeshes()) transformMesh(mesh, tm.elements);
  // 3) simplify
  await doc.transform(weld());
  if (it.tris && triCount(doc) > it.tris) await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: it.tris / triCount(doc), error: it.error ?? 0.002, lockBorder: false }));
  if (it.crease != null) creaseNormals(doc, it.crease);
  // 4) clean materials: base colour only, opaque, double-sided off
  for (const mat of root.listMaterials()) {
    mat.setMetallicRoughnessTexture(null).setNormalTexture(null).setOcclusionTexture(null).setEmissiveTexture(null);
    mat.setMetallicFactor(0).setRoughnessFactor(0.85).setAlphaMode('OPAQUE').setDoubleSided(false);
  }
  await doc.transform(prune(), dedup());
  const mtr = metrics(doc);
  // 5) textures + compression
  await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [it.tex || 1024, it.tex || 1024], quality: it.q || 80 }));
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  const out = path.join(OUT, it.name + '.glb');
  await io.write(out, doc);
  const kb = (fs.statSync(out).size / 1024).toFixed(0);
  console.log(JSON.stringify({ name: it.name, trisIn: t0, trisOut: triCount(doc), kb: +kb, scale: +s.toFixed(4), ...mtr }));
}
