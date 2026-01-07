import { useRef, useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useRollerCoaster, LoopSegment } from "@/lib/stores/useRollerCoaster";
import { getTrackCurve } from "./Track";

interface TrackSection {
  type: "spline" | "loop";
  startProgress: number;
  endProgress: number;
  arcLength: number;
  segmentIndex?: number;
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

export function RideCamera() {
  const { camera } = useThree();
  const { trackPoints, loopSegments, isRiding, rideProgress, setRideProgress, rideSpeed, stopRide, isLooped, hasChainLift } = useRollerCoaster();
  
  const curveRef = useRef<THREE.CatmullRomCurve3 | null>(null);
  const previousCameraPos = useRef(new THREE.Vector3());
  const previousLookAt = useRef(new THREE.Vector3());
  const maxHeightReached = useRef(0);
  const transportedUp = useRef(new THREE.Vector3(0, 1, 0));
  const lastProgress = useRef(0);
  
  const { sections, totalArcLength, firstPeakProgress } = useMemo(() => {
    if (trackPoints.length < 2) {
      return { sections: [], totalArcLength: 0, firstPeakProgress: 0.2 };
    }
    
    const curve = getTrackCurve(trackPoints, isLooped);
    if (!curve) return { sections: [], totalArcLength: 0, firstPeakProgress: 0.2 };
    
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
          segmentIndex: i
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
          segmentIndex: i
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
    
    let maxHeight = -Infinity;
    let peakProgress = 0.2;
    let foundClimb = false;
    
    for (let p = 0; p <= 0.5; p += 0.01) {
      const sample = sampleHybridTrack(p, sections, curve);
      if (sample) {
        if (sample.tangent.y > 0.1) foundClimb = true;
        if (foundClimb && sample.point.y > maxHeight) {
          maxHeight = sample.point.y;
          peakProgress = p;
        }
        if (foundClimb && sample.tangent.y < -0.1 && p > peakProgress) break;
      }
    }
    
    return { sections, totalArcLength: accumulatedLength, firstPeakProgress: peakProgress };
  }, [trackPoints, loopSegments, isLooped]);
  
  useEffect(() => {
    curveRef.current = getTrackCurve(trackPoints, isLooped);
  }, [trackPoints, isLooped]);
  
  useEffect(() => {
    if (isRiding && curveRef.current) {
      const startPoint = curveRef.current.getPoint(0);
      maxHeightReached.current = startPoint.y;
      transportedUp.current.set(0, 1, 0);
      lastProgress.current = 0;
    }
  }, [isRiding]);
  
  useFrame((_, delta) => {
    if (!isRiding || !curveRef.current || sections.length === 0) return;
    
    const curve = curveRef.current;
    
    const currentSample = sampleHybridTrack(rideProgress, sections, curve);
    if (!currentSample) return;
    
    const currentHeight = currentSample.point.y;
    
    let speed: number;
    
    if (hasChainLift && rideProgress < firstPeakProgress) {
      const chainSpeed = 0.9 * rideSpeed;
      speed = chainSpeed;
      maxHeightReached.current = Math.max(maxHeightReached.current, currentHeight);
    } else {
      const constantSpeed = 12.0;
      speed = constantSpeed * rideSpeed;
    }
    
    const progressDelta = (speed * delta) / totalArcLength;
    let newProgress = rideProgress + progressDelta;
    
    if (newProgress >= 1) {
      if (isLooped) {
        newProgress = newProgress % 1;
        if (hasChainLift) {
          const startPoint = curve.getPoint(0);
          maxHeightReached.current = startPoint.y;
        }
      } else {
        stopRide();
        return;
      }
    }
    
    setRideProgress(newProgress);
    
    const sample = sampleHybridTrack(newProgress, sections, curve);
    if (!sample) return;
    
    const { point: position, tangent, up: sampleUp, inLoop } = sample;
    
    if (inLoop) {
      transportedUp.current.copy(sampleUp);
    } else {
      const prevSample = sampleHybridTrack(lastProgress.current, sections, curve);
      if (prevSample && !prevSample.inLoop) {
        const prevTangent = prevSample.tangent;
        
        const rotationAxis = new THREE.Vector3().crossVectors(prevTangent, tangent);
        const rotationAngle = Math.acos(Math.min(1, Math.max(-1, prevTangent.dot(tangent))));
        
        if (rotationAxis.lengthSq() > 0.0001 && rotationAngle > 0.0001) {
          rotationAxis.normalize();
          transportedUp.current.applyAxisAngle(rotationAxis, rotationAngle);
        }
        
        const dot = transportedUp.current.dot(tangent);
        transportedUp.current.sub(tangent.clone().multiplyScalar(dot));
        if (transportedUp.current.lengthSq() > 0.0001) {
          transportedUp.current.normalize();
        } else {
          transportedUp.current.set(0, 1, 0);
          const d2 = transportedUp.current.dot(tangent);
          transportedUp.current.sub(tangent.clone().multiplyScalar(d2)).normalize();
        }
      } else {
        transportedUp.current.copy(sampleUp);
      }
    }
    
    lastProgress.current = newProgress;
    
    const baseUpVector = transportedUp.current.clone();
    
    const cameraHeight = 1.2;
    const cameraOffset = baseUpVector.clone().multiplyScalar(cameraHeight);
    const targetCameraPos = position.clone().add(cameraOffset);
    
    const lookDistance = 10;
    const targetLookAt = position.clone().add(tangent.clone().multiplyScalar(lookDistance));
    
    previousCameraPos.current.lerp(targetCameraPos, 0.5);
    previousLookAt.current.lerp(targetLookAt, 0.5);
    
    camera.position.copy(previousCameraPos.current);
    
    camera.up.copy(baseUpVector);
    camera.lookAt(previousLookAt.current);
  });
  
  return null;
}

function sampleHybridTrack(
  progress: number,
  sections: TrackSection[],
  spline: THREE.CatmullRomCurve3
): { point: THREE.Vector3; tangent: THREE.Vector3; up: THREE.Vector3; inLoop: boolean } | null {
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
    const sample = sampleLoopAnalytically(section.loopSegment, theta);
    return { ...sample, inLoop: true };
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
    
    return { point, tangent, up, inLoop: false };
  }
  
  return null;
}
