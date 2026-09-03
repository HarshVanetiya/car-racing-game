/**
 * Fixed-rate game loop.
 *
 * Physics runs at a fixed step inside RaceSession; this loop drives rendering
 * at the display refresh and hands it the real elapsed time. It also clamps
 * long frames — after a tab has been backgrounded, `requestAnimationFrame` can
 * report a gap of many seconds, and simulating all of it at once would both
 * stall the browser and teleport every car.
 */
export class Loop {
  constructor(callback, opts = {}) {
    this.callback = callback;
    this.maxFrameTime = opts.maxFrameTime ?? 0.1;
    this.running = false;
    this._last = 0;
    this._raf = null;
    this._frame = this._frame.bind(this);

    this.fps = 60;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this.frameCount = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._frame);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _frame(now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._frame);

    let dt = (now - this._last) / 1000;
    this._last = now;
    if (dt > this.maxFrameTime) dt = this.maxFrameTime;
    if (dt <= 0) return;

    this.frameCount++;
    this._fpsAccum += dt;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.5) {
      this.fps = this._fpsFrames / this._fpsAccum;
      this._fpsAccum = 0;
      this._fpsFrames = 0;
    }

    this.callback(dt, now / 1000);
  }
}
