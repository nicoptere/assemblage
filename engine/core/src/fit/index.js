/**
 * Rebuilding a shape out of rigid parts: a target volume from a mesh (TargetVolume), parts as
 * weighted volume stencils (partStencil), and a greedy volumetric fit (ShapeFit).
 */
export { TargetVolume } from './TargetVolume.js';
export { partStencil } from './PartVolume.js';
export { ShapeFit, FIT_DEFAULTS } from './ShapeFit.js';
