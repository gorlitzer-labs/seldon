import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Edges, Html } from "@react-three/drei";
import { useRef } from "react";
import * as THREE from "three";
import { useFocus, useView, useDeck } from "../deck/deck";
import { MODULE_ORDER, MODULES } from "../content/modules";
import type { ModuleId } from "../content/types";

const GOLD = new THREE.Color("#e8ad3c");
const R = 1, THICK = 0.4, D = 1.7;

/** Petal ring positions, index = MODULE_ORDER index. */
const PETALS: [number, number, number][] = MODULE_ORDER.map((_, i) => {
  const a = (Math.PI / 3) * i;
  return [D * Math.cos(a), D * Math.sin(a), 0];
});
const posOf = (m: ModuleId) => PETALS[MODULE_ORDER.indexOf(m)];

/** Drives every hex + the camera from the current beat's focus/view. */
function Honeycomb() {
  const group = useRef<THREE.Group>(null!);
  const petalRefs = useRef<THREE.Mesh[]>([]);
  const centerRef = useRef<THREE.Mesh>(null!);
  const focus = useFocus();
  const view = useView();
  const syllabus = useDeck((s) => s.view) === "syllabus";
  const { camera } = useThree();
  const portra = () => (typeof window !== 'undefined' && window.innerWidth < 820 ? 1.5 : 1);
  const camTarget = useRef(new THREE.Vector3(0, -0.6, 7));
  const lookTarget = useRef(new THREE.Vector3(0, 0, 0));
  const look = useRef(new THREE.Vector3(0, 0, 0));

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    const k = Math.min(1, dt * 1.9); // lerp factor — deliberate fly between modules

    // camera framing
    if (focus) {
      const p = posOf(focus);
      camTarget.current.set(p[0] * 1.1, p[1] * 1.1 - 0.2, (view === "surface" ? 6.2 : 5.4) * portra());
      lookTarget.current.set(p[0], p[1], 0.4);
    } else {
      camTarget.current.set(0, -0.6, (syllabus ? 9.6 : view === "combo" ? 8.2 : 8) * portra());
      lookTarget.current.set(0, 0, 0);
    }
    camera.position.lerp(camTarget.current, k);
    look.current.lerp(lookTarget.current, k);
    camera.lookAt(look.current);

    // idle rotation only on the whole hive
    const idle = focus == null && view !== "surface";
    const targetYaw = idle ? Math.sin(t * 0.16) * 0.35 : 0;
    const targetPit = idle ? -0.30 + Math.sin(t * 0.12) * 0.05 : -0.12;
    group.current.rotation.y += (targetYaw - group.current.rotation.y) * k;
    group.current.rotation.x += (targetPit - group.current.rotation.x) * k;

    // per-hex lift + brightness + fade (surface dims the whole hive)
    const dim = syllabus ? 0.4 : view === "surface" ? 0.22 : 1;
    petalRefs.current.forEach((mesh, i) => {
      if (!mesh) return;
      const isFocus = focus === MODULE_ORDER[i];
      const zTarget = isFocus ? 0.9 : 0;
      mesh.position.z += (zTarget - mesh.position.z) * k;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const emTarget = (isFocus ? 0.5 : 0.16) * (focus && !isFocus ? 0.5 : 1) * (syllabus ? 0.6 : 1);
      mat.emissiveIntensity += (emTarget - mat.emissiveIntensity) * k;
      const opTarget = focus && !isFocus ? 0.4 * dim : dim;
      mat.opacity += (opTarget - mat.opacity) * k;
    });
    if (centerRef.current) {
      const mat = centerRef.current.material as THREE.MeshStandardMaterial;
      mat.opacity += (dim - mat.opacity) * k;
    }
  });

  return (
    <group ref={group}>
      <mesh ref={centerRef} position={[0, 0, -0.05]} rotation={[Math.PI / 2, 0, Math.PI / 6]}>
        <cylinderGeometry args={[R * 0.97, R * 0.97, THICK, 6]} />
        <meshStandardMaterial color="#1c1710" metalness={0.55} roughness={0.34}
          emissive={GOLD} emissiveIntensity={0.5} transparent opacity={1} />
        <Edges threshold={15} color="#ffc95a" />
      </mesh>
      {PETALS.map((p, i) => (
        <mesh key={i} ref={(el) => (petalRefs.current[i] = el!)} position={p}
          rotation={[Math.PI / 2, 0, Math.PI / 6]}>
          <cylinderGeometry args={[R * 0.97, R * 0.97, THICK, 6]} />
          <meshStandardMaterial color="#13151d" metalness={0.55} roughness={0.34}
            emissive={GOLD} emissiveIntensity={0.16} transparent opacity={1} />
          <Edges threshold={15} color="#e8ad3c" />
        </mesh>
      ))}
      {PETALS.map((p, i) => {
        const m = MODULES[MODULE_ORDER[i]];
        const hidden = view === "surface" || syllabus;
        const dim = !!focus && focus !== MODULE_ORDER[i];
        return (
          <Html key={"l" + i} position={[p[0], p[1], 0.55]} center distanceFactor={9} pointerEvents="none" zIndexRange={[8, 0]}>
            <div className={"hexlabel" + (hidden ? " hide" : "") + (dim ? " dim" : "")}>
              <svg viewBox="0 0 40 40"><g dangerouslySetInnerHTML={{ __html: m.emblem }} /></svg>
              <span>{m.nm}</span>
            </div>
          </Html>
        );
      })}
    </group>
  );
}

export function Scene() {
  return (
    <Canvas className="stage" camera={{ position: [0, -0.6, 7], fov: 38 }} dpr={[1, 2]} gl={{ antialias: true }}>
      <color attach="background" args={["#0a0b10"]} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[4, 7, 9]} intensity={1.5} color="#fff6e6" />
      <directionalLight position={[-6, 2, 3]} intensity={0.5} color="#e8ad3c" />
      <Honeycomb />
    </Canvas>
  );
}
