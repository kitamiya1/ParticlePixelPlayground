// 減色用のカラーパレット（いずれも本プロジェクト用に作成したオリジナル配色）。

export interface PaletteDef {
  id: string;
  label: string;
  colors: string[];
}

export const PALETTES: PaletteDef[] = [
  { id: 'none', label: 'なし（フルカラー）', colors: [] },
  { id: 'levels', label: '階調制限（RGB 各チャンネル）', colors: [] },
  {
    id: 'meadow32',
    label: '草原 38色',
    colors: [
      '#1b1f33', '#2c3654', '#3f5a86', '#5d8bc0', '#8fc0e6', '#cfe8f5', '#ffffff',
      '#1f3b2c', '#2d5a37', '#3f7d3c', '#5aa046', '#84c25a', '#b7dc78',
      '#3b2a22', '#5e4030', '#8a5f3f', '#b88a5a', '#e0bd8a', '#e6d3b0',
      '#4a4650', '#6d6a72', '#94909a', '#bdb8bf',
      '#f3c9a0', '#e88a5a', '#c8483c', '#8e2f3a', '#f2d45c',
      '#f2a7c3', '#b06aa8', '#6a4a8a', '#3a8fb7',
      '#d6ec9a', '#7f93b5', '#aebfd9', '#3c3550', '#e58fb0', '#f9d3e0',
    ],
  },
  {
    id: 'dusk16',
    label: '夕暮れ 16色',
    colors: ['#1a1428', '#2e2140', '#4d2f55', '#7a3f62', '#b25462', '#e07a5f', '#f2b880', '#fbe3b0', '#2c3e3a', '#3f5e45', '#6b8a52', '#a7b468', '#5a6f8c', '#8aa3c2', '#c9c2d9', '#fff4e0'],
  },
  {
    id: 'pastel12',
    label: 'パステル 12色',
    colors: ['#2b2d42', '#5c6b8a', '#9fb4d8', '#e8f0ff', '#6fa877', '#a9d39e', '#e9e3a0', '#f4b8a0', '#d98c9a', '#a58bc4', '#8a6f5a', '#c9b49a'],
  },
  { id: 'green4', label: '携帯機風 緑4階調', colors: ['#1d2b1f', '#3e6b3a', '#8bb05a', '#d8e8a8'] },
  { id: 'mono8', label: 'モノクロ 8階調', colors: ['#101014', '#2a2a30', '#47474f', '#67676f', '#8a8a90', '#aeaeb2', '#d2d2d2', '#f4f4f0'] },
];

export const MAX_PALETTE = 64;

export function paletteById(id: string): PaletteDef {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}
