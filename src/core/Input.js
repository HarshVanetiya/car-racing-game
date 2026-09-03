import { clamp, clamp01, lerp } from '../math/MathUtils.js';

/**
 * ============================================================================
 *  INPUT
 * ============================================================================
 *
 * Keyboard and gamepad, normalised into the analogue controls the vehicle
 * expects.
 *
 * Keys are digital but the car needs analogue input, so key presses are ramped
 * rather than stepped. That is not a cosmetic smoothing: a car whose throttle
 * snaps from 0 to 1 is undriveable in this physics model, because the rear
 * tires cannot take it. The ramp is the keyboard equivalent of a driver's
 * ankle, and the rates are chosen so a keyboard player can still modulate.
 */

export const DEFAULT_BINDINGS = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  shiftUp: ['KeyE', 'ShiftRight'],
  shiftDown: ['KeyQ', 'ShiftLeft'],
  drs: ['Space'],
  handbrake: ['KeyX'],
  pitLimiter: ['KeyL'],
  camera: ['KeyC'],
  lookBack: ['KeyB'],
  resetCar: ['KeyR'],
  pause: ['Escape'],
  hud: ['KeyH'],
  pitRequest: ['KeyP'],
  timingTower: ['KeyT']
};

export class Input {
  constructor(target = window) {
    this.target = target;
    this.bindings = { ...DEFAULT_BINDINGS };
    this.keys = new Set();
    this.justPressed = new Set();

    // Analogue axes, ramped from digital keys.
    this.throttle = 0;
    this.brake = 0;
    this.steer = 0;
    this.handbrake = 0;

    this.drs = false;
    this.lookBack = false;
    this.gamepadIndex = null;
    this.usingGamepad = false;
    this.enabled = true;

    // Ramp rates, in units per second.
    this.rates = {
      throttleUp: 3.2,
      throttleDown: 6.0,
      brakeUp: 4.2,
      brakeDown: 7.0,
      steerUp: 3.4,
      steerReturn: 5.4
    };

    // Steering sensitivity applied to keyboard input only; a stick is already
    // analogue and should be passed through.
    this.keyboardSteerCurve = 1.0;

    this._onKeyDown = (e) => {
      if (!this.enabled) return;
      if (e.repeat) return;
      // Do not steal keys from text fields.
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      this.keys.add(e.code);
      this.justPressed.add(e.code);
      if (this._consumesKey(e.code)) e.preventDefault();
      this.usingGamepad = false;
    };
    this._onKeyUp = (e) => {
      this.keys.delete(e.code);
      if (this._consumesKey(e.code)) e.preventDefault();
    };
    this._onBlur = () => { this.keys.clear(); };

    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('blur', this._onBlur);
    target.addEventListener('gamepadconnected', (e) => {
      this.gamepadIndex = e.gamepad.index;
    });
    target.addEventListener('gamepaddisconnected', () => {
      this.gamepadIndex = null;
      this.usingGamepad = false;
    });
  }

  _consumesKey(code) {
    for (const list of Object.values(this.bindings)) {
      if (list.includes(code)) return true;
    }
    return false;
  }

  isDown(action) {
    const list = this.bindings[action];
    if (!list) return false;
    for (const code of list) if (this.keys.has(code)) return true;
    return false;
  }

  /** True only on the frame the action was first pressed. */
  wasPressed(action) {
    const list = this.bindings[action];
    if (!list) return false;
    for (const code of list) if (this.justPressed.has(code)) return true;
    return false;
  }

  /** Read the gamepad, if one is being used. */
  _pollGamepad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    let pad = this.gamepadIndex != null ? pads[this.gamepadIndex] : null;
    if (!pad) {
      for (const p of pads) if (p && p.connected) { pad = p; this.gamepadIndex = p.index; break; }
    }
    if (!pad) return null;

    // Standard mapping: triggers on axes 6/7 or buttons 6/7 depending on the pad.
    const deadzone = 0.08;
    const applyDeadzone = (v) => Math.abs(v) < deadzone ? 0 : (v - Math.sign(v) * deadzone) / (1 - deadzone);

    const steer = applyDeadzone(pad.axes[0] ?? 0);
    let throttle = 0, brake = 0;
    if (pad.buttons[7]) throttle = pad.buttons[7].value;
    if (pad.buttons[6]) brake = pad.buttons[6].value;
    // Some pads report triggers as axes in [-1, 1].
    if (throttle === 0 && pad.axes.length > 5) throttle = clamp01(((pad.axes[5] ?? -1) + 1) / 2);
    if (brake === 0 && pad.axes.length > 4) brake = clamp01(((pad.axes[4] ?? -1) + 1) / 2);

    const anyInput = Math.abs(steer) > 0.02 || throttle > 0.02 || brake > 0.02 ||
                     pad.buttons.some((b) => b.pressed);
    if (anyInput) this.usingGamepad = true;

    return {
      steer, throttle, brake,
      shiftUp: pad.buttons[5]?.pressed || pad.buttons[0]?.pressed,
      shiftDown: pad.buttons[4]?.pressed || pad.buttons[1]?.pressed,
      drs: pad.buttons[2]?.pressed,
      handbrake: pad.buttons[3]?.pressed ? 1 : 0,
      camera: pad.buttons[9]?.pressed,
      lookBack: pad.buttons[10]?.pressed,
      pause: pad.buttons[8]?.pressed
    };
  }

  /**
   * Produce analogue controls for this frame.
   * @returns {object} { throttle, brake, steer, handbrake, drs, ... }
   */
  update(dt) {
    const pad = this._pollGamepad();
    this.justPressedGamepad = {};

    if (pad && this.usingGamepad) {
      // Analogue input passes through directly.
      this.throttle = clamp01(pad.throttle);
      this.brake = clamp01(pad.brake);
      this.steer = clamp(pad.steer, -1, 1);
      this.handbrake = pad.handbrake;
      this.drs = !!pad.drs;
      this._padEdge(pad);
    } else {
      const r = this.rates;
      // Throttle and brake ramp toward their target rather than snapping.
      const wantThrottle = this.isDown('throttle') ? 1 : 0;
      const wantBrake = this.isDown('brake') ? 1 : 0;
      this.throttle = approach(this.throttle, wantThrottle, r.throttleUp, r.throttleDown, dt);
      this.brake = approach(this.brake, wantBrake, r.brakeUp, r.brakeDown, dt);

      // Steering ramps in and springs back to centre.
      const l = this.isDown('left'), rr = this.isDown('right');
      const wantSteer = (rr ? 1 : 0) - (l ? 1 : 0);
      if (wantSteer === 0) {
        this.steer = approach(this.steer, 0, r.steerReturn, r.steerReturn, dt);
      } else {
        // Turning the other way is quicker than building lock from centre,
        // which is what makes a correction possible on a keyboard.
        const rate = Math.sign(this.steer) !== 0 && Math.sign(this.steer) !== wantSteer
          ? r.steerUp * 2.0 : r.steerUp;
        this.steer = clamp(this.steer + wantSteer * rate * dt, -1, 1);
      }

      this.handbrake = this.isDown('handbrake') ? 1 : 0;
      this.drs = this.isDown('drs');
    }

    this.lookBack = pad ? !!pad.lookBack : this.isDown('lookBack');

    const result = {
      throttle: this.throttle,
      brake: this.brake,
      steer: this.steer,
      handbrake: this.handbrake,
      drs: this.drs,
      lookBack: this.lookBack,
      shiftUp: this.wasPressed('shiftUp') || this._padPressed('shiftUp'),
      shiftDown: this.wasPressed('shiftDown') || this._padPressed('shiftDown'),
      camera: this.wasPressed('camera') || this._padPressed('camera'),
      pitLimiter: this.wasPressed('pitLimiter'),
      resetCar: this.wasPressed('resetCar'),
      pause: this.wasPressed('pause') || this._padPressed('pause'),
      hud: this.wasPressed('hud'),
      pitRequest: this.wasPressed('pitRequest'),
      timingTower: this.wasPressed('timingTower')
    };

    this.justPressed.clear();
    return result;
  }

  _padEdge(pad) {
    this._padPrev = this._padPrev || {};
    this._padNow = {};
    for (const key of ['shiftUp', 'shiftDown', 'camera', 'pause', 'lookBack']) {
      this._padNow[key] = !!pad[key];
    }
  }

  _padPressed(key) {
    if (!this._padNow) return false;
    const now = this._padNow[key];
    const prev = this._padPrev?.[key];
    if (now && !prev) {
      this._padPrev = { ...this._padNow };
      return true;
    }
    this._padPrev = { ...this._padNow };
    return false;
  }

  setBindings(bindings) {
    this.bindings = { ...DEFAULT_BINDINGS, ...bindings };
  }

  reset() {
    this.throttle = 0; this.brake = 0; this.steer = 0; this.handbrake = 0;
    this.keys.clear(); this.justPressed.clear();
  }

  dispose() {
    this.target.removeEventListener('keydown', this._onKeyDown);
    this.target.removeEventListener('keyup', this._onKeyUp);
    this.target.removeEventListener('blur', this._onBlur);
  }
}

function approach(current, target, upRate, downRate, dt) {
  const rate = target > current ? upRate : downRate;
  const delta = target - current;
  const step = rate * dt;
  if (Math.abs(delta) <= step) return target;
  return current + Math.sign(delta) * step;
}
