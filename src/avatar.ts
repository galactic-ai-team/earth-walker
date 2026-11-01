// Lane: Lumi — procedural low-poly humanoid for third-person walk mode.
// Built from Cesium box/ellipsoid primitives (no downloaded models). Each body
// part is its own Primitive whose modelMatrix is updated every frame, so the
// walk cycle (leg/arm swing + bob) costs no geometry rebuilds.
import {
  BoxGeometry,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  EllipsoidGeometry,
  GeometryInstance,
  Matrix3,
  Matrix4,
  PerInstanceColorAppearance,
  Primitive,
  Transforms,
  type Viewer,
} from 'cesium';
import type { WalkState } from './walk';

/** Swing group a part belongs to; legs and arms swing in opposite phase. */
export type Limb = 'none' | 'legL' | 'legR' | 'armL' | 'armR';

export interface PartSpec {
  name: string;
  limb: Limb;
  shape: 'box' | 'sphere';
  /** Box size or ellipsoid diameters (x right, y forward, z up), metres. */
  size: [number, number, number];
  /** Joint position in the body frame (feet at origin), metres. */
  pivot: [number, number, number];
  /** Part centre relative to its joint, metres. */
  offset: [number, number, number];
  color: string;
}

const SHIRT = '#c8432f';
const PANTS = '#2b3a55';
const SKIN = '#e0b48c';
const SHOES = '#1d1d1d';
const HAIR = '#3b2618';

export const HIP_Z = 0.93;
export const SHOULDER_Z = 1.46;

/** Body plan: about 1.78 m tall, feet at z = 0, facing +y. */
export const BODY: readonly PartSpec[] = [
  { name: 'legL', limb: 'legL', shape: 'box', size: [0.15, 0.17, 0.85], pivot: [-0.1, 0, HIP_Z], offset: [0, 0, -0.425], color: PANTS },
  { name: 'legR', limb: 'legR', shape: 'box', size: [0.15, 0.17, 0.85], pivot: [0.1, 0, HIP_Z], offset: [0, 0, -0.425], color: PANTS },
  { name: 'shoeL', limb: 'legL', shape: 'box', size: [0.14, 0.27, 0.08], pivot: [-0.1, 0, HIP_Z], offset: [0, 0.05, -0.89], color: SHOES },
  { name: 'shoeR', limb: 'legR', shape: 'box', size: [0.14, 0.27, 0.08], pivot: [0.1, 0, HIP_Z], offset: [0, 0.05, -0.89], color: SHOES },
  { name: 'hips', limb: 'none', shape: 'box', size: [0.38, 0.22, 0.16], pivot: [0, 0, HIP_Z], offset: [0, 0, 0.05], color: PANTS },
  { name: 'torso', limb: 'none', shape: 'box', size: [0.44, 0.25, 0.5], pivot: [0, 0, HIP_Z], offset: [0, 0, 0.36], color: SHIRT },
  { name: 'neck', limb: 'none', shape: 'box', size: [0.1, 0.1, 0.08], pivot: [0, 0, SHOULDER_Z], offset: [0, 0, 0.04], color: SKIN },
  { name: 'head', limb: 'none', shape: 'sphere', size: [0.21, 0.24, 0.26], pivot: [0, 0, SHOULDER_Z], offset: [0, 0.01, 0.2], color: SKIN },
  { name: 'hair', limb: 'none', shape: 'sphere', size: [0.22, 0.24, 0.14], pivot: [0, 0, SHOULDER_Z], offset: [0, -0.02, 0.29], color: HAIR },
  { name: 'armL', limb: 'armL', shape: 'box', size: [0.11, 0.12, 0.6], pivot: [-0.28, 0, SHOULDER_Z], offset: [0, 0, -0.28], color: SHIRT },
  { name: 'armR', limb: 'armR', shape: 'box', size: [0.11, 0.12, 0.6], pivot: [0.28, 0, SHOULDER_Z], offset: [0, 0, -0.28], color: SHIRT },
  { name: 'handL', limb: 'armL', shape: 'box', size: [0.09, 0.1, 0.1], pivot: [-0.28, 0, SHOULDER_Z], offset: [0, 0, -0.63], color: SKIN },
  { name: 'handR', limb: 'armR', shape: 'box', size: [0.09, 0.1, 0.1], pivot: [0.28, 0, SHOULDER_Z], offset: [0, 0, -0.63], color: SKIN },
];

export interface Pose {
  /** Leg swing, radians; positive swings the left leg forward. */
  legSwing: number;
  /** Arm swing, radians (opposite to the legs). */
  armSwing: number;
  /** Vertical bob of the whole body, metres. */
  bob: number;
  /** Forward lean, radians (more when running). */
  lean: number;
}

/** Stride length in metres per full gait cycle grows a little with speed. */
export function strideLength(speed: number): number {
  return 1.2 + Math.min(speed, 10) * 0.12;
}

/** Advance the gait phase (radians) by distance walked. */
export function advancePhase(phase: number, speed: number, dt: number): number {
  if (speed <= 0 || dt <= 0) return phase;
  const next = phase + (2 * Math.PI * speed * dt) / strideLength(speed);
  return next % (2 * Math.PI * 1000); // keep it bounded without visible jumps
}

/** Pose for a gait phase at a speed (m/s); speed 0 = standing straight. */
export function walkPose(phase: number, speed: number): Pose {
  const amount = Math.min(Math.max(speed, 0) / 3, 1.6); // 1 at a walk (3 m/s), more when running
  const s = Math.sin(phase);
  return {
    legSwing: 0.45 * amount * s,
    armSwing: -0.4 * amount * s,
    bob: 0.035 * amount * Math.abs(Math.cos(phase)),
    lean: 0.06 * Math.max(0, amount - 0.6),
  };
}

/** Turn `current` toward `target` by at most maxStep radians, the short way round. */
export function approachAngle(current: number, target: number, maxStep: number): number {
  let diff = (target - current) % (2 * Math.PI);
  if (diff > Math.PI) diff -= 2 * Math.PI;
  if (diff < -Math.PI) diff += 2 * Math.PI;
  if (Math.abs(diff) <= maxStep) return target;
  return current + Math.sign(diff) * maxStep;
}

/** Swing angle for a limb in a pose (left/right alternate). */
export function limbAngle(limb: Limb, pose: Pose): number {
  switch (limb) {
    case 'legL':
      return pose.legSwing;
    case 'legR':
      return -pose.legSwing;
    case 'armL':
      return pose.armSwing;
    case 'armR':
      return -pose.armSwing;
    default:
      return 0;
  }
}

/**
 * Part transform in the body frame (x right, y forward, z up, feet at 0):
 * bob · lean · joint · swing about x · offset. Rotating +angle about x swings
 * a hanging limb forward (+y).
 */
export function partLocalMatrix(part: PartSpec, pose: Pose, result = new Matrix4()): Matrix4 {
  const lean = Matrix4.fromRotation(Matrix3.fromRotationX(-pose.lean), new Matrix4());
  const bob = Matrix4.fromTranslation(new Cartesian3(0, 0, pose.bob), new Matrix4());
  const joint = Matrix4.fromTranslation(new Cartesian3(...part.pivot), new Matrix4());
  const swing = Matrix4.fromRotation(Matrix3.fromRotationX(limbAngle(part.limb, pose)), new Matrix4());
  const offset = Matrix4.fromTranslation(new Cartesian3(...part.offset), new Matrix4());
  Matrix4.multiply(bob, lean, result);
  Matrix4.multiply(result, joint, result);
  Matrix4.multiply(result, swing, result);
  return Matrix4.multiply(result, offset, result);
}

export interface Avatar {
  update(state: WalkState, dt: number): void;
  setVisible(visible: boolean): void;
  destroy(): void;
}

export function createAvatar(viewer: Viewer): Avatar {
  const appearance = new PerInstanceColorAppearance({ flat: false, translucent: false });
  const parts = BODY.map((spec) => {
    const [x, y, z] = spec.size;
    const geometry =
      spec.shape === 'box'
        ? BoxGeometry.fromDimensions({
            dimensions: new Cartesian3(x, y, z),
            vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
          })
        : new EllipsoidGeometry({
            radii: new Cartesian3(x / 2, y / 2, z / 2),
            vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
            stackPartitions: 10,
            slicePartitions: 12,
          });
    const primitive = new Primitive({
      geometryInstances: new GeometryInstance({
        geometry,
        attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(spec.color)) },
      }),
      appearance,
      asynchronous: false, // tiny geometry; build on the main thread, no worker round-trip
      show: false,
    });
    viewer.scene.primitives.add(primitive);
    return { spec, primitive };
  });

  let yaw: number | undefined;
  let phase = 0;
  let speedSm = 0;
  let visible = false;
  const frame = new Matrix4();
  const body = new Matrix4();
  const local = new Matrix4();
  const yawM = new Matrix4();
  const scratchPos = new Cartesian3();

  return {
    update(state, dt) {
      if (!visible || !state.ready) {
        for (const p of parts) p.primitive.show = false;
        return;
      }
      // Face where we're actually going (GTA-style); hold the last facing when still.
      const target = state.moveHeading ?? yaw ?? state.heading;
      yaw = yaw === undefined ? target : approachAngle(yaw, target, 10 * dt);
      speedSm += (state.speed - speedSm) * (1 - Math.exp(-dt / 0.12));
      if (speedSm < 0.05) speedSm = 0;
      phase = speedSm > 0 ? advancePhase(phase, speedSm, dt) : phase * 0.85; // relax to standing
      const pose = walkPose(phase, speedSm);

      Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(state.lon, state.lat, state.feet, undefined, scratchPos), undefined, frame);
      // Body +y (forward) -> heading: rotate about up by -yaw (heading is clockwise).
      Matrix4.fromRotation(Matrix3.fromRotationZ(-yaw), yawM);
      Matrix4.multiply(frame, yawM, body);
      for (const p of parts) {
        partLocalMatrix(p.spec, pose, local);
        p.primitive.modelMatrix = Matrix4.multiply(body, local, p.primitive.modelMatrix ?? new Matrix4());
        p.primitive.show = true;
      }
    },
    setVisible(v) {
      visible = v;
      if (!v) {
        for (const p of parts) p.primitive.show = false;
        yaw = undefined;
      }
    },
    destroy() {
      for (const p of parts) viewer.scene.primitives.remove(p.primitive);
    },
  };
}
