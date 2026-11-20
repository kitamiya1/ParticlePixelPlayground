// スプラット用の陰影モディファイア（Spark の dyno = GPU 上でスプラットを生成・加工するプログラム）。
// 方式 A の粒の頂点シェーダー（shaders.ts の particleVertex）と同じ式で光・影・風・霞を計算し、
// 同じ浮き島・同じ色調で比較できるようにする。ユニフォームは方式 A と同じオブジェクトを共有する。

import * as THREE from 'three';
import { dyno } from '@sparkjsdev/spark';
import type { SharedUniforms } from '../ParticleMaterial';
import { ATTR_TEX_WIDTH } from './SplatData';

/** 方式 B だけが使う追加ユニフォーム */
export function createSplatUniforms() {
  return {
    camPos: { value: new THREE.Vector3() },
    camDir: { value: new THREE.Vector3(0, 0, -1) },
    /** x: 広がり, y: 広がり×異方性（縦）, z: 広がり×平たさ（厚み） */
    spread: { value: new THREE.Vector3(1, 1, 0.2) },
    opacity: { value: 1 },
  };
}
export type SplatUniforms = ReturnType<typeof createSplatUniforms>;

// 共有ユニフォーム（方式 A と同じ値）→ GLSL 名
const SHARED_KEYS = [
  ['uTime', 'float'], ['uWind', 'float'], ['uWindDir', 'vec2'], ['uSunDir', 'vec3'], ['uSunColor', 'vec3'], ['uSkyColor', 'vec3'],
  ['uGroundColor', 'vec3'], ['uAmbient', 'float'], ['uShadowStrength', 'float'], ['uLightSteps', 'float'], ['uCharPos', 'vec3'],
  ['uFogColor', 'vec3'], ['uFogNear', 'float'], ['uFogFar', 'float'], ['uFogStrength', 'float'], ['uMistColor', 'vec3'],
] as const;
const SPLAT_KEYS = [['camPos', 'vec3'], ['camDir', 'vec3'], ['spread', 'vec3'], ['opacity', 'float']] as const;

const SHADE_GLSL = /* glsl */ `
${SHARED_KEYS.map(([k, t]) => `uniform ${t} ppp_${k};`).join('\n')}
${SPLAT_KEYS.map(([k, t]) => `uniform ${t} ppp_${k};`).join('\n')}

float pppHash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
vec3 pppQuatVec(vec4 q, vec3 v) {
  vec3 t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

// attr.x: 焼き込み日照, attr.y: 風の影響度
void pppShade(inout Gsplat g, vec2 attr, float receiveBlob, float drawCount) {
  if (float(g.index) >= drawCount) { g.rgba.a = 0.0; return; }
  vec3 wn = normalize(pppQuatVec(g.quaternion, vec3(0.0, 0.0, 1.0)));
  vec3 wp = g.center;

  // 風（方式 A と同じ式）
  float w = attr.y;
  if (w > 0.0 && ppp_uWind > 0.0) {
    float ph = pppHash13(g.center * 7.31) * 6.2831;
    float wave = dot(wp.xz, ppp_uWindDir) * 0.35;
    float gust = 0.55 + 0.45 * sin(ppp_uTime * 0.8 - wave * 0.6);
    float sway = sin(ppp_uTime * 2.1 - wave + ph * 0.3) * 0.6 + sin(ppp_uTime * 3.7 + ph) * 0.25;
    vec2 side = vec2(-ppp_uWindDir.y, ppp_uWindDir.x);
    vec2 off = ppp_uWindDir * (gust * 0.6 + sway * 0.45) + side * sin(ppp_uTime * 1.3 + ph) * 0.15;
    wp.xz += off * w * ppp_uWind * 0.32;
    wp.y -= length(off) * w * ppp_uWind * 0.04;
  }

  // 光：半球環境光 + 太陽（焼き込み影 × 段階化）
  float ndl = max(dot(wn, ppp_uSunDir), 0.0);
  float sh = mix(1.0, attr.x, ppp_uShadowStrength);
  float blob = 0.0;
  if (receiveBlob > 0.5) {
    float dist = length(wp.xz - ppp_uCharPos.xz);
    float dy = ppp_uCharPos.y - wp.y;
    blob = (1.0 - smoothstep(0.22, 0.5, dist)) * step(-0.35, dy) * (1.0 - smoothstep(0.8, 2.0, dy));
    sh *= 1.0 - blob * ppp_uShadowStrength;
  }
  float direct = ndl * sh;
  if (ppp_uLightSteps > 0.5) direct = floor(direct * ppp_uLightSteps + 0.5) / ppp_uLightSteps;
  vec3 hemi = mix(ppp_uGroundColor, ppp_uSkyColor, wn.y * 0.5 + 0.5);
  vec3 c = g.rgba.rgb * (hemi * ppp_uAmbient * (1.0 - blob * 0.3) + ppp_uSunColor * direct);

  // 奥行き：視線方向の霞 + 島の下の靄
  float viewD = dot(wp - ppp_camPos, ppp_camDir);
  float fogF = smoothstep(ppp_uFogNear, ppp_uFogFar, viewD) * ppp_uFogStrength;
  float mist = (1.0 - smoothstep(-16.0, -2.0, wp.y)) * ppp_uFogStrength * 0.75;
  c = mix(c, ppp_uMistColor, clamp(mist, 0.0, 0.7));
  c = mix(c, ppp_uFogColor, clamp(fogF, 0.0, 0.8));

  g.center = wp;
  g.rgba.rgb = clamp(c, 0.0, 1.0);
  g.rgba.a *= ppp_opacity;
  // 広がり・異方性・平たさ（円盤の法線 = ローカル Z 方向を薄くする）
  g.scales *= ppp_spread;
}
`;

/**
 * ワールド座標でかけるモディファイアを作る。
 * attr: スプラット番号で引く付加情報テクスチャ（無ければ日照 1・風 0）
 */
export function createShadeModifier(opts: {
  shared: SharedUniforms;
  splat: SplatUniforms;
  drawCount: { value: number };
  attr?: THREE.DataTexture;
  receiveBlob: boolean;
  /** 用途ごとの固定名。作り直しても同じシェーダーソースになり、プログラムが使い回される */
  role: 'world' | 'char';
}) {
  const id = opts.role;
  const uniforms: Record<string, THREE.IUniform> = {};
  for (const [k] of SHARED_KEYS) uniforms[`ppp_${k}`] = opts.shared[k];
  for (const [k] of SPLAT_KEYS) uniforms[`ppp_${k}`] = opts.splat[k];
  const drawName = `ppp_drawCount_${id}`;
  uniforms[drawName] = opts.drawCount;
  const attrName = `ppp_attr_${id}`;
  if (opts.attr) uniforms[attrName] = { value: opts.attr };
  const perMeshGlobals = [`uniform float ${drawName};`];
  if (opts.attr) perMeshGlobals.push(`uniform sampler2D ${attrName};`);

  return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    const shade = new dyno.Dyno({
      inTypes: { gsplat: dyno.Gsplat },
      outTypes: { gsplat: dyno.Gsplat },
      inputs: { gsplat },
      generate: ({ inputs, outputs }) => ({
        globals: [SHADE_GLSL, ...perMeshGlobals],
        uniforms,
        statements: [
          `${outputs.gsplat} = ${inputs.gsplat};`,
          `if (isGsplatActive(${outputs.gsplat}.flags)) {`,
          `  int pppIdx = ${outputs.gsplat}.index;`,
          `  vec2 pppAttr = ${opts.attr ? `texelFetch(${attrName}, ivec2(pppIdx % ${ATTR_TEX_WIDTH}, pppIdx / ${ATTR_TEX_WIDTH}), 0).rg` : 'vec2(1.0, 0.0)'};`,
          `  pppShade(${outputs.gsplat}, pppAttr, ${opts.receiveBlob ? '1.0' : '0.0'}, ${drawName});`,
          `}`,
        ],
      }),
    });
    return { gsplat: shade.outputs.gsplat };
  });
}
