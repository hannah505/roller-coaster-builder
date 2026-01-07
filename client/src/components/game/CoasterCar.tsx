import { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useRollerCoaster, LoopSegment } from "@/lib/stores/useRollerCoaster";
import { getTrackCurve } from "./Track";

interface TrackSection {
  type: "spline" | "loop";
  startProgress: number;
  endProgress: number;
  arcLength: number;
  loopSegment?: LoopSegment;
  splineStartT?: number;
  splineEndT?: number;
}

function sampleLoopAnalytically(
  segment: LoopSegment,
  theta: number
): { point: THREE.Vector3; tangent: THREE.Vector3; up: THREE.Vector3 } {
  const { entryPos, forward, up, radius } = segment;
  
  const point = new THREE.Vector3(
    entryPos.x + forward.x * Math.sin(theta) * radius + up.x * (1 - Math.cos(theta)) * radius,
    entryPos.y + forward.y * Math.sin(theta) * radius + up.y * (1 - Math.cos(theta)) * radius,
    entryPos.z + forward.z * Math.sin(theta) * radius + up.z * (1 - Math.cos(theta)) * radius
  );
  
  const tangent = new THREE.Vector3()
    .addScaledVector(forward, Math.cos(theta))
    .addScaledVector(up, Math.sin(theta))
    .normalize();
  
  const inwardUp = new THREE.Vector3()
    .addScaledVector(forward, -Math.sin(theta))
    .addScaledVector(up, Math.cos(theta))
    .normalize();
  
  return { point, tangent, up: inwardUp };
}

function sampleHybridTrack(
  progress: number,
  sections: TrackSection[],
  spline: THREE.CatmullRomCurve3
): { point: THREE.Vector3; tangent: THREE.Vector3; up: THREE.Vector3 } | null {
  if (sections.length === 0) return null;
  
  progress = Math.max(0, Math.min(progress, 0.9999));
  
  let section: TrackSection | null = null;
  for (const s of sections) {
    if (progress >= s.startProgress && progress < s.endProgress) {
      section = s;
      break;
    }
  }
  
  if (!section) {
    section = sections[sections.length - 1];
  }
  
  const localT = (progress - section.startProgress) / (section.endProgress - section.startProgress);
  
  if (section.type === "loop" && section.loopSegment) {
    const theta = localT * Math.PI * 2;
    return sampleLoopAnalytically(section.loopSegment, theta);
  } else if (section.splineStartT !== undefined && section.splineEndT !== undefined) {
    const splineT = section.splineStartT + localT * (section.splineEndT - section.splineStartT);
    const point = spline.getPoint(splineT);
    const tangent = spline.getTangent(splineT).normalize();
    
    let up = new THREE.Vector3(0, 1, 0);
    const dot = up.dot(tangent);
    up.sub(tangent.clone().multiplyScalar(dot));
    if (up.lengthSq() > 0.001) {
      up.normalize();
    } else {
      up.set(1, 0, 0);
      const d = up.dot(tangent);
      up.sub(tangent.clone().multiplyScalar(d)).normalize();
    }
    
    return { point, tangent, up };
  }
  
  return null;
}

export function CoasterCar() {
  const meshRef = useRef<THREE.Group>(null);
  const { trackPoints, loopSegments, rideProgress, isRiding, mode, isLooped } = useRollerCoaster();
  
  const sections = useMemo(() => {
    if (trackPoints.length < 2) return [];
    
    const curve = getTrackCurve(trackPoints, isLooped);
    if (!curve) return [];
    
    const loopMap = new Map<string, { segment: LoopSegment; pointIndex: number }>();
    for (const seg of loopSegments) {
      const idx = trackPoints.findIndex(p => p.id === seg.entryPointId);
      if (idx !== -1) {
        loopMap.set(seg.entryPointId, { segment: seg, pointIndex: idx });
      }
    }
    
    const numPoints = trackPoints.length;
    const totalSplineSegments = isLooped ? numPoints : numPoints - 1;
    const sections: TrackSection[] = [];
    let accumulatedLength = 0;
    
    for (let i = 0; i < numPoints; i++) {
      const point = trackPoints[i];
      const loopInfo = loopMap.get(point.id);
      
      if (loopInfo) {
        const loopArcLength = 2 * Math.PI * loopInfo.segment.radius;
        sections.push({
          type: "loop",
          startProgress: 0,
          endProgress: 0,
          arcLength: loopArcLength,
          loopSegment: loopInfo.segment,
        });
        accumulatedLength += loopArcLength;
      } else {
        if (i >= numPoints - 1 && !isLooped) continue;
        
        const splineStartT = i / totalSplineSegments;
        const splineEndT = (i + 1) / totalSplineSegments;
        
        let segmentLength = 0;
        const subSamples = 10;
        for (let s = 0; s < subSamples; s++) {
          const t1 = splineStartT + (s / subSamples) * (splineEndT - splineStartT);
          const t2 = splineStartT + ((s + 1) / subSamples) * (splineEndT - splineStartT);
          const p1 = curve.getPoint(t1);
          const p2 = curve.getPoint(t2);
          segmentLength += p1.distanceTo(p2);
        }
        
        sections.push({
          type: "spline",
          startProgress: 0,
          endProgress: 0,
          arcLength: segmentLength,
          splineStartT,
          splineEndT,
        });
        accumulatedLength += segmentLength;
      }
    }
    
    let runningLength = 0;
    for (const section of sections) {
      section.startProgress = runningLength / accumulatedLength;
      runningLength += section.arcLength;
      section.endProgress = runningLength / accumulatedLength;
    }
    
    return sections;
  }, [trackPoints, loopSegments, isLooped]);
  
  useFrame(() => {
    if (!meshRef.current || !isRiding) return;
    
    const curve = getTrackCurve(trackPoints, isLooped);
    if (!curve || sections.length === 0) return;
    
    const sample = sampleHybridTrack(rideProgress, sections, curve);
    if (!sample) return;
    
    const { point: position, tangent, up } = sample;
    
    meshRef.current.position.copy(position);
    meshRef.current.position.addScaledVector(up, -0.3);
    
    const angle = Math.atan2(tangent.x, tangent.z);
    meshRef.current.rotation.y = angle;
    
    const pitch = Math.asin(-tangent.y);
    meshRef.current.rotation.x = pitch;
    
    const right = new THREE.Vector3().crossVectors(tangent, up).normalize();
    const roll = Math.atan2(right.y, up.y);
    meshRef.current.rotation.z = roll;
  });
  
  if (!isRiding || mode !== "ride") return null;
  
  return (
    <group ref={meshRef}>
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[1, 0.5, 2]} />
        <meshStandardMaterial color="#ff0000" metalness={0.7} roughness={0.3} />
      </mesh>
      <mesh position={[0, 0.4, -0.5]}>
        <boxGeometry args={[0.8, 0.3, 0.6]} />
        <meshStandardMaterial color="#333333" />
      </mesh>
      <mesh position={[-0.5, -0.35, 0.6]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.15, 0.15, 0.1, 16]} />
        <meshStandardMaterial color="#222222" metalness={0.8} />
      </mesh>
      <mesh position={[0.5, -0.35, 0.6]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.15, 0.15, 0.1, 16]} />
        <meshStandardMaterial color="#222222" metalness={0.8} />
      </mesh>
      <mesh position={[-0.5, -0.35, -0.6]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.15, 0.15, 0.1, 16]} />
        <meshStandardMaterial color="#222222" metalness={0.8} />
      </mesh>
      <mesh position={[0.5, -0.35, -0.6]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.15, 0.15, 0.1, 16]} />
        <meshStandardMaterial color="#222222" metalness={0.8} />
      </mesh>
    </group>
  );
}
