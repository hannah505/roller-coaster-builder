import { useRef, useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useRollerCoaster, LoopSegment } from "@/lib/stores/useRollerCoaster";
import { getTrackCurve } from "./Track";

interface TrackSection {
  type: "spline" | "roll";
  startProgress: number;
  endProgress: number;
  arcLength: number;
  rollFrame?: BarrelRollFrame;
  splineStartT?: number;
  splineEndT?: number;
  pointIndex?: number;
}

interface BarrelRollFrame {
  entryPos: THREE.Vector3;
  forward: THREE.Vector3;
  up: THREE.Vector3;
  right: THREE.Vector3;
  radius: number;
  pitch: number;
}

// Vertical loop: track goes in a vertical circle, rider goes upside down at top
function sampleVerticalLoopAnalytically(
  frame: BarrelRollFrame,
  t: number
): { point: THREE.Vector3; tangent: THREE.Vector3; up: THREE.Vector3 } {
  const { entryPos, forward, up: U0, right: R0, radius, pitch } = frame;
  
  const twoPi = Math.PI * 2;
  
  const theta = twoPi * (t - Math.sin(twoPi * t) / twoPi);
  const dThetaDt = twoPi * (1 - Math.cos(twoPi * t));
  
  // Vertical loop in forward-up plane
  const point = new THREE.Vector3()
    .copy(entryPos)
    .addScaledVector(forward, pitch * t + radius * Math.sin(theta))
    .addScaledVector(U0, radius * (1 - Math.cos(theta)));
  
  const tangent = new THREE.Vector3()
    .copy(forward).multiplyScalar(pitch + radius * Math.cos(theta) * dThetaDt)
    .addScaledVector(U0, radius * Math.sin(theta) * dThetaDt)
    .normalize();
  
  // Up rotates around right axis - upside down at θ=π
  const rotatedUp = new THREE.Vector3()
    .addScaledVector(U0, Math.cos(theta))
    .addScaledVector(forward, -Math.sin(theta))
    .normalize();
  
  return { point, tangent, up: rotatedUp };
}

function computeRollFrame(
  spline: THREE.CatmullRomCurve3,
  splineT: number,
  radius: number,
  pitch: number,
  rollOffset: THREE.Vector3
): BarrelRollFrame {
  const entryPos = spline.getPoint(splineT).add(rollOffset);
  const forward = spline.getTangent(splineT).normalize();
  
  // Use WORLD up to build roll frame - keeps roll horizontal and going UP first
  const worldUp = new THREE.Vector3(0, 1, 0);
  let entryUp = worldUp.clone();
  const upDot = entryUp.dot(forward);
  entryUp.sub(forward.clone().multiplyScalar(upDot));
  if (entryUp.length() > 0.001) {
    entryUp.normalize();
  } else {
    entryUp.set(1, 0, 0);
    const d = entryUp.dot(forward);
    entryUp.sub(forward.clone().multiplyScalar(d)).normalize();
  }
  
  const right = new THREE.Vector3().crossVectors(forward, entryUp).normalize();
  
  return { entryPos, forward, up: entryUp, right, radius, pitch };
}

// Compute arc length of eased barrel roll numerically
function computeRollArcLength(radius: number, pitch: number): number {
  const steps = 100;
  let length = 0;
  const twoPi = Math.PI * 2;
  
  for (let i = 0; i < steps; i++) {
    const t1 = i / steps;
    const t2 = (i + 1) / steps;
    
    const theta1 = twoPi * (t1 - Math.sin(twoPi * t1) / twoPi);
    const theta2 = twoPi * (t2 - Math.sin(twoPi * t2) / twoPi);
    const dTheta = theta2 - theta1;
    
    // Approximate position change
    const dForward = pitch / steps;
    const dRadial = radius * Math.sqrt(dTheta * dTheta);
    
    length += Math.sqrt(dForward * dForward + dRadial * dRadial);
  }
  
  return length;
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
    
    const loopMap = new Map<string, LoopSegment>();
    for (const seg of loopSegments) {
      loopMap.set(seg.entryPointId, seg);
    }
    
    const numPoints = trackPoints.length;
    const totalSplineSegments = isLooped ? numPoints : numPoints - 1;
    const sections: TrackSection[] = [];
    let accumulatedLength = 0;
    let rollOffset = new THREE.Vector3(0, 0, 0);
    
    let prevTangent = curve.getTangent(0).normalize();
    let prevUp = new THREE.Vector3(0, 1, 0);
    const initDot = prevUp.dot(prevTangent);
    prevUp.sub(prevTangent.clone().multiplyScalar(initDot));
    if (prevUp.length() < 0.01) {
      prevUp.set(1, 0, 0);
      const d = prevUp.dot(prevTangent);
      prevUp.sub(prevTangent.clone().multiplyScalar(d));
    }
    prevUp.normalize();
    
    for (let i = 0; i < numPoints; i++) {
      const point = trackPoints[i];
      const loopSeg = loopMap.get(point.id);
      
      if (loopSeg) {
        const splineT = i / totalSplineSegments;
        const rollFrame = computeRollFrame(curve, splineT, loopSeg.radius, loopSeg.pitch, rollOffset.clone());
        
        const rollArcLength = computeRollArcLength(loopSeg.radius, loopSeg.pitch);
        
        sections.push({
          type: "roll",
          startProgress: 0,
          endProgress: 0,
          arcLength: rollArcLength,
          rollFrame,
          pointIndex: i
        });
        accumulatedLength += rollArcLength;
        
        rollOffset.addScaledVector(rollFrame.forward, loopSeg.pitch);
        
        // After eased roll, tangent and up return to entry values
        prevTangent.copy(rollFrame.forward);
        prevUp.copy(rollFrame.up);
      }
      
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
        pointIndex: i
      });
      accumulatedLength += segmentLength;
      
      const endTangent = curve.getTangent(splineEndT).normalize();
      const dot = Math.max(-1, Math.min(1, prevTangent.dot(endTangent)));
      if (dot < 0.9999 && dot > -0.9999) {
        const axis = new THREE.Vector3().crossVectors(prevTangent, endTangent);
        if (axis.length() > 0.0001) {
          axis.normalize();
          const angle = Math.acos(dot);
          const quat = new THREE.Quaternion().setFromAxisAngle(axis, angle);
          prevUp.applyQuaternion(quat);
        }
      }
      const upDot = prevUp.dot(endTangent);
      prevUp.sub(endTangent.clone().multiplyScalar(upDot));
      if (prevUp.length() > 0.001) prevUp.normalize();
      prevTangent.copy(endTangent);
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
      const sample = sampleHybridTrack(p, sections, curve, loopSegments, trackPoints, isLooped);
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
    
    const currentSample = sampleHybridTrack(rideProgress, sections, curve, loopSegments, trackPoints, isLooped);
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
    
    const sample = sampleHybridTrack(newProgress, sections, curve, loopSegments, trackPoints, isLooped);
    if (!sample) return;
    
    const { point: position, tangent, up: sampleUp, inRoll } = sample;
    
    if (inRoll) {
      transportedUp.current.copy(sampleUp);
    } else {
      const prevSample = sampleHybridTrack(lastProgress.current, sections, curve, loopSegments, trackPoints, isLooped);
      if (prevSample && !prevSample.inRoll) {
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
  spline: THREE.CatmullRomCurve3,
  loopSegments: LoopSegment[],
  trackPoints: { id: string; position: THREE.Vector3 }[],
  isLooped: boolean
): { point: THREE.Vector3; tangent: THREE.Vector3; up: THREE.Vector3; inRoll: boolean } | null {
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
  
  if (section.type === "roll" && section.rollFrame) {
    const sample = sampleVerticalLoopAnalytically(section.rollFrame, localT);
    return { ...sample, inRoll: true };
  } else if (section.splineStartT !== undefined && section.splineEndT !== undefined) {
    const splineT = section.splineStartT + localT * (section.splineEndT - section.splineStartT);
    const point = spline.getPoint(splineT);
    const tangent = spline.getTangent(splineT).normalize();
    
    let rollOffset = new THREE.Vector3(0, 0, 0);
    const loopMap = new Map<string, LoopSegment>();
    for (const seg of loopSegments) {
      loopMap.set(seg.entryPointId, seg);
    }
    
    const numPoints = trackPoints.length;
    const totalSplineSegments = isLooped ? numPoints : numPoints - 1;
    
    for (let i = 0; i < numPoints && i <= (section.pointIndex ?? 0); i++) {
      const tp = trackPoints[i];
      const loopSeg = loopMap.get(tp.id);
      if (loopSeg) {
        const spT = i / totalSplineSegments;
        const fwd = spline.getTangent(spT).normalize();
        rollOffset.addScaledVector(fwd, loopSeg.pitch);
      }
    }
    
    point.add(rollOffset);
    
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
    
    return { point, tangent, up, inRoll: false };
  }
  
  return null;
}
