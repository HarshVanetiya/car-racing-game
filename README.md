# Apex Circuit

A 3D multiplayer Formula-style racing game that runs in a browser. Everything
the car does — how it accelerates, how it turns, how it loses grip and what it
does when it finds it again — comes out of a vehicle dynamics simulation
written from scratch. There are no "handling" stats, no speed boosts, and
nothing that steers the car on the driver's behalf.

The design principle the whole project is built around:

> **The player should win because they drove the car better, not because the
> game secretly moved the car for them.**

```
npm install
npm run dev            # game on :5173, race server on :8787
```

Then open <http://localhost:5173>. Single player needs nothing else running;
multiplayer connects to the race server.

---

## The simulation

Every behaviour in the game is the end of one chain, and each link is a real
physical model rather than a tuned curve:

```
Engine → Transmission → Differential → Wheels → Tires → Track surface
                                          ↕         ↕
                                     Suspension  Aerodynamics
                                          ↕         ↕
                                    Vehicle mass ← Driver inputs
```

**Tires** (`src/physics/Tire.js`) use a Pacejka-style Magic Formula. Grip rises
to a peak at a few percent of slip and then genuinely falls away, so a sliding
tire is slower than one at the limit — the single most important thing in the
game. Longitudinal and lateral slip are normalised by their own peaks and
combined as a vector, which gives a friction ellipse for free: the grip spent
on braking is not available for turning. Grip falls as load rises, so weight
transfer changes the balance. Two thermal layers (a tread that reacts within a
corner, a carcass that holds heat across a lap) sit around a temperature
window, and wear runs to a performance cliff.

**Wheels and suspension** (`src/physics/Wheel.js`) are raycast, with springs,
separate bump and rebound damping, bump stops and anti-roll bars. Each wheel
integrates its own rotation against drive, brake and tire torque, including the
engine inertia reflected through the square of the gear ratio — which is why a
low gear feels heavy and wheelspin builds progressively.

**Weight transfer is not modelled.** Tire forces are applied at the contact
patches of a rigid body with a real inertia tensor, so load moves forward under
braking and outward in a corner because that is what the forces do.

**Aerodynamics** (`src/physics/Aero.js`) scale with the square of speed, split
across front and rear centres of pressure, and gain from ground effect as the
floor approaches the road. At 340 km/h the car makes over twice its own weight
in downforce, which is why cornering grip nearly doubles between 80 and
300 km/h. One shared wake solver produces both effects of following: a tow that
cuts drag, and dirty air that costs the front wing far more than the rear — the
understeer that makes overtaking hard.

**Drivetrain**: a torque curve with a real power band, a sequential box with a
torque cut on every shift, a slipping clutch that makes a standing start
self-regulating, a Salisbury limited-slip differential, and carbon brakes with
per-corner temperature that are weak cold and fade when cooked.

Validated behaviour: 0–100 km/h in 3.8 s, 0–200 in 6.9 s, 331 km/h top speed
(355 with DRS), 300–0 in 128 m at 4.2 g — and 171 m if the wheels lock. Lateral
grip runs from 1.84 g at 80 km/h to 3.50 g at 300 km/h. 75% throttle
out-launches 100%.

## The circuit

Apex Circuit is 5.35 km with 13 corners, 23 m of elevation change and three
sectors that ask for different things: a long climbing straight into the
heaviest stop of the lap, a technical middle sector over a crest and down to a
first-gear hairpin, and a fast flowing final third. It has three DRS zones, a pit
lane, kerbs that really do unsettle the car, and surfaces — asphalt, kerb,
grass, gravel — with their own grip, drag and dirt.

The geometry is an arc-length-parameterised spline sampled into flat arrays,
with a uniform spatial grid making the ground query the physics runs four times
per wheel per step an O(1) lookup. Racing lines are derived from the difference
between narrow-window and wide-window curvature averages, which produces
outside-inside-outside without anyone drawing it.

## The AI

AI drivers use the same `Vehicle` as the player and reach it through the same
three controls. They have no extra grip, no extra power and no knowledge of the
future beyond a speed profile any driver could work out.

That profile is built in three passes: an iterative solve for the cornering
speed each point can hold given downforce and load transfer, a backward pass
that walks braking points back from every corner, and a forward pass that
limits how fast the car can accelerate out of one. The driver then follows it
with a feedforward steering angle, bounded cross-track feedback, and two slow
integrators that trim braking and throttle the way a real driver learns a
corner. Skill levels change only how much of the car's limit a driver is
willing to use, plus reaction time and consistency.

## Multiplayer

The server is authoritative (`server/`). Clients simulate their own car and
send state at 30 Hz; the server validates it for plausibility — rejecting
teleports, impossible speeds and NaNs — runs the race director, and broadcasts
snapshots at 20 Hz. Remote cars are rendered one interpolation interval in the
past and blended between snapshots, with bounded extrapolation across a
dropout, so other cars move smoothly on a bad connection instead of teleporting.

## What is in the game

Race weekends (practice → qualifying → race, with qualifying setting the grid),
quick races, time trial, qualifying and practice, plus online multiplayer with
a lobby. Lap and sector timing with personal and session bests, a timing tower,
progress-based positions, penalties and track limits, pit stops with a tire and
fuel strategy that matters, dynamic weather with a drying line, six camera
modes, a full HUD, procedural audio synthesised at runtime (no sample files),
seven assists, each of which can be turned off, and a car setup where every field maps
onto a physical parameter.

## Layout

```
src/math/       Vectors, quaternions, splines — no dependencies, shared with the server
src/physics/    Tire, wheel, engine, transmission, differential, brakes, aero, vehicle
src/track/      Circuit definition, track model, surface and ground queries
src/ai/         Speed profile and driver
src/race/       Timing, race director, rules, weather, session, weekend
src/net/        Protocol, client, snapshot interpolation
src/render/     Three.js scene, generated geometry, cameras, effects
src/audio/      Web Audio synthesis
src/ui/         Screens and HUD
server/         Authoritative race server
test/           Unit tests, plus browser, UI and multiplayer integration tests
```

The circuit and every sound are generated at runtime. The one asset is
`public/models/car.glb`, the car body; if it cannot be fetched the game falls
back to a procedural car and carries on.

## Tests

```
npm test              # 99 unit tests: physics, track, race, net, AI
npm run test:browser  # loads the built game, drives it, checks WebGL/HUD/cameras
npm run test:ui       # walks the menu, setup and results screens
npm run test:modes    # starts every mode, then runs a weekend end to end
npm run test:net      # two real clients against the race server
npm run profile       # where each frame's time goes on THIS machine
```

The unit tests assert behaviours rather than numbers: that grip peaks and then
falls away, that braking eats cornering grip, that a heavier car is never
faster, that a stationary car cannot rotate, that skill changes cornering speed
but not top speed. The browser, UI and multiplayer tests need a server running
(`npm run dev`, or `npm run build && npm run preview`).

## Performance

The simulation is cheap and the rendering is what costs: a full 20-car grid at
240 Hz is about 14% of one core, while drawing the scene is everything else.
Two things follow from that.

**Draw calls are the budget.** The circuit is built as separate pieces — a kerb
block, a barrier segment, a tree — which is the right way to write it and the
wrong way to draw it. `mergeStatic.js` collapses everything static into one
mesh per material per stretch of track after the builders have run, which took
the circuit from 951 meshes and 590 draw calls a frame down to around 220. The
car model does the same job for the cars: one mesh per material instead of the
two dozen the procedural body needs.

**Input runs at the simulation's rate, not the display's.** The car steps at
240 Hz, and the pedals and wheel are advanced once per step rather than once
per frame. Without that, a machine managing 20 fps feeds the tyres a staircase
and the car feels disconnected however good the physics underneath is.

If it still runs badly, `npm run profile` says where the time is going.
`wallPerFrame` far above the sum of the parts means the GPU is the limit — turn
the quality down in Settings, which drops the render resolution first, then
shadows, then antialiasing.

Running the race server on the same machine as the client costs one more full
simulation: the server is authoritative and simulates every car itself. That is
about 14% of a core for a 20-car grid, so it is not usually what makes a game
stutter — but it is a whole core's worth of headroom you no longer have.

## Deploying it

Single player is a folder of static files and needs no backend at all, so the
client and the race server deploy separately. `DEPLOY.md` has the full guide;
the short version is GitHub Pages for the client (free, no account beyond the
one you have, workflow already in the repo) and a Node host that allows
WebSockets for the server. `npm start` serves both halves from one process if
you would rather run it as a single service.

## Controls

WASD or the arrow keys for the pedals and the wheel, E and Q (or the shift
keys) for gears, Space for DRS, X for the handbrake, L for the pit limiter,
C to change camera, B to look back, P to request a pit stop, T for the timing
tower, H for the HUD, R to reset the car, Esc to pause. A gamepad works too.
The full list is on the Controls & Help screen.
