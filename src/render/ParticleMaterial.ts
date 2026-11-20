// 粒描画用マテリアル。全マテリアルで共有するユニフォームを 1 か所で管理する。

import * as THREE from 'three';
import { particleFragment, particleVertex } from './shaders';

export function createSharedUniforms() {
  return {
    uTime: { value: 0 },
    uPointScale: { value: 1 },
    uPxPerUnit: { value: 20 },
    uIsOrtho: { value: 1 },
    uWind: { value: 1 },
    uWindDir: { value: new THREE.Vector2(0.8, 0.6).normalize() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(0.86, 0.79, 0.64) },
    uSkyColor: { value: new THREE.Color(0.6, 0.68, 0.85) },
    uGroundColor: { value: new THREE.Color(0.42, 0.36, 0.28) },
    uAmbient: { value: 0.85 },
    uShadowStrength: { value: 0.8 },
    uLightSteps: { value: 4 },
    uRes: { value: new THREE.Vector2(640, 360) },
    uSnap: { value: 1 },
    uCharPos: { value: new THREE.Vector3() },
    uFogColor: { value: new THREE.Color('#bcd8ee') },
    uFogNear: { value: 80 },
    uFogFar: { value: 130 },
    uFogStrength: { value: 0.6 },
    uMistColor: { value: new THREE.Color('#c9def0') },
    uGaussShade: { value: 0.5 },
    uGaussSharp: { value: 2.2 },
    uAlphaCut: { value: 0.2 },
    uAlphaDither: { value: 1 },
  };
}

export type SharedUniforms = ReturnType<typeof createSharedUniforms>;

export function createParticleMaterial(shared: SharedUniforms, opts: { bones?: THREE.Matrix4[]; receiveBlob?: boolean }) {
  // スプレッドで「同じユニフォームオブジェクト」を参照させる（値の更新が全マテリアルに反映される）
  const uniforms: Record<string, THREE.IUniform> = { ...shared, uReceiveBlob: { value: opts.receiveBlob ? 1 : 0 } };
  const defines: Record<string, string> = {};
  if (opts.bones) {
    uniforms.uBones = { value: opts.bones };
    defines.USE_BONES = '';
  }
  return new THREE.ShaderMaterial({
    uniforms,
    defines,
    vertexShader: particleVertex,
    fragmentShader: particleFragment,
    transparent: false,
    depthWrite: true,
    depthTest: true,
  });
}
