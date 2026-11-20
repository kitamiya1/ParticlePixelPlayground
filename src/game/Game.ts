// ゲームロジックのまとめ役。描画システムには依存せず、状態だけを更新する。

import { IslandLayout } from '../world/IslandLayout';
import { CameraRig } from './CameraRig';
import { CharacterController } from './CharacterController';
import { Input } from './Input';

export class Game {
  readonly layout: IslandLayout;
  readonly character: CharacterController;
  readonly camera = new CameraRig();
  readonly input: Input;
  time = 0;

  constructor(surface: HTMLElement, seed = 7) {
    this.layout = new IslandLayout(seed);
    this.character = new CharacterController(this.layout);
    this.input = new Input(surface);
    const c = this.character;
    this.camera.target = { x: c.x, y: c.y + 0.6, z: c.z };
  }

  toggleViewing(): boolean {
    this.camera.viewing = !this.camera.viewing;
    return this.camera.viewing;
  }

  update(dt: number) {
    this.time += dt;
    const input = this.input;
    const move = input.moveAxis();
    const viewing = this.camera.viewing;
    this.character.update(dt, viewing ? { x: 0, y: 0 } : move, input.isRunning(), this.camera.yaw);
    const c = this.character;
    this.camera.update(dt, input, { x: c.x, y: c.y + 0.6, z: c.z }, viewing ? move : { x: 0, y: 0 });
    input.consume();
  }
}
