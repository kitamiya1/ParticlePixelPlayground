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
  {
    // 水槽ゲーム用：青緑の水の階調・砂・水草・流木・岩・カニの赤褐色（本プロジェクト用のオリジナル配色）
    id: 'aquarium55',
    label: '水槽 55色',
    colors: [
      '#0b1e2a', '#10323f', '#164a55', '#1f6466', '#2e8079', '#4aa08d', '#78bfa6', '#b4dcc4', '#e4f4ea',
      '#1b2a44', '#2c4a6e', '#4a78a0', '#86b4d4', '#cfe6f2',
      '#5a4a36', '#7d6a4c', '#a48d66', '#c8b48a', '#e3d4ad', '#f4ead0',
      '#18301f', '#24482a', '#336534', '#4c8540', '#6fa64e', '#9fc768', '#cfe39a',
      '#2a1d17', '#452e22', '#6a4630', '#8f6444',
      '#2b2e33', '#44484f', '#62666d', '#858a90', '#aab0b4', '#d2d6d6',
      '#4a1d18', '#7a2e22', '#a84530', '#d06a3e', '#ea9a62', '#f1caa0',
      '#0c0d12', '#ffffff', '#3a3230', '#5c4f47',
      // 水中の砂・岩（青緑に寄った中間色。これが無いと水中の砂が灰色に寄る）
      '#46594f', '#5f7262', '#7d8f78', '#98a88c', '#b3bf9f', '#cfd6b8', '#3a6a62', '#5a8f84',
    ],
  },
  { id: 'green4', label: '携帯機風 緑4階調', colors: ['#1d2b1f', '#3e6b3a', '#8bb05a', '#d8e8a8'] },
  { id: 'mono8', label: 'モノクロ 8階調', colors: ['#101014', '#2a2a30', '#47474f', '#67676f', '#8a8a90', '#aeaeb2', '#d2d2d2', '#f4f4f0'] },
];

export const MAX_PALETTE = 64;

export function paletteById(id: string): PaletteDef {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}
