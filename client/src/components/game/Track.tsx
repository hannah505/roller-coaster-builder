import { useMemo } from "react";
import * as THREE from "three";
import { useRollerCoaster, LoopSegment } from "@/lib/stores/useRollerCoaster";
import { Line } from "@react-three/drei";

function interpolateTilt(trackPoints: { tilt: number }[], t: number, isLooped: boolean): number {
  if (trackPoints.length < 2) return 0;
  
  const n = trackPoints.length;
  const scaledT = isLooped ? t * n : t * (n - 1);
  const index = Math.floor(scaledT);
  const frac = scaledT - index;
  
  if (isLooped) {
    const i0 = index % n;
    const i1 = (index + 1) % n;
    return trackPoints[i0].tilt * (1 - frac) + trackPoints[i1].tilt * frac;
  } else {
    if (index >= n - 1) return trackPoints[n - 1].tilt;
    return trackPoints[index].tilt * (1 - frac) + trackPoints[index + 1].tilt * frac;
  }
}

interface RailSample {
  point: THREE.Vector3;
  tangent: THREE.Vector3;
  normal: THREE.Vector3;
  up: THREE.Vector3;
  tilt: number;
}

interface BarrelRollFrame {
  entryPos: THREE.Vector3;
  forward: THREE.Vector3;
  up: THREE.Vector3;
  right: THREE.Vector3;
  radius: number;
  pitch: number;
}

// Vertical loop: track goes in a vertical circle in the forward-up plane
// Rider goes upside down at the top (θ=π), loop is perpendicular to track direction
// θ(t) = 2π * (t - sin(2πt)/(2π)) ensures zero angular velocity at endpoints for C1 continuity
function sampleVerticalLoopAnalytically(
  frame: BarrelRollFrame,
  t: number  // 0 to 1
): { point: THREE.Vector3; tangent: THREE.Vector3; up: THREE.Vector3; normal: THREE.Vector3 } {
  const { entryPos, forward, up: U0, right: R0, radius, pitch } = frame;
  
  const twoPi = Math.PI * 2;
  
  // Eased theta: starts and ends with zero angular velocity
  const theta = twoPi * (t - Math.sin(twoPi * t) / twoPi);
  const dThetaDt = twoPi * (1 - Math.cos(twoPi * t));
  
  // Vertical loop in forward-up plane:
  // - forward component: radius*sin(θ) creates the forward/backward motion
  // - up component: radius*(1-cos(θ)) creates the vertical motion (always >= 0)
  // - pitch*t advances the exit point ahead of entry
  const point = new THREE.Vector3()
    .copy(entryPos)
    .addScaledVector(forward, pitch * t + radius * Math.sin(theta))
    .addScaledVector(U0, radius * (1 - Math.cos(theta)));
  
  // Tangent: derivative of position
  // dP/dt = forward*(pitch + radius*cos(θ)*dθ/dt) + U0*(radius*sin(θ)*dθ/dt)
  const tangent = new THREE.Vector3()
    .copy(forward).multiplyScalar(pitch + radius * Math.cos(theta) * dThetaDt)
    .addScaledVector(U0, radius * Math.sin(theta) * dThetaDt)
    .normalize();
  
  // Up vector rotates around the RIGHT axis (perpendicular to the loop plane)
  // At θ=0: up = U0 (normal)
  // At θ=π: up = -U0 (upside down at top of loop!)
  // At θ=2π: up = U0 (back to normal)
  const rotatedUp = new THREE.Vector3()
    .addScaledVector(U0, Math.cos(theta))
    .addScaledVector(forward, -Math.sin(theta))
    .normalize();
  
  // Right vector stays constant (perpendicular to the loop plane)
  const normal = R0.clone();
  
  return { point, tangent, up: rotatedUp, normal };
}

export function Track() {
  const { trackPoints, loopSegments, isLooped, showWoodSupports, isNightMode } = useRollerCoaster();
  
  const { railData, woodSupports, trackLights } = useMemo(() => {
    if (trackPoints.length < 2) {
      return { railData: [], woodSupports: [], trackLights: [] };
    }
    
    const points = trackPoints.map((p) => p.position.clone());
    const baseSpline = new THREE.CatmullRomCurve3(points, isLooped, "catmullrom", 0.5);
    
    const loopMap = new Map<string, LoopSegment>();
    for (const seg of loopSegments) {
      loopMap.set(seg.entryPointId, seg);
    }
    
    const railData: RailSample[] = [];
    const numSamplesPerSegment = 20;
    const numTrackPoints = trackPoints.length;
    const totalSplineSegments = isLooped ? numTrackPoints : numTrackPoints - 1;
    
    let prevTangent = baseSpline.getTangent(0).normalize();
    let prevUp = new THREE.Vector3(0, 1, 0);
    const initDot = prevUp.dot(prevTangent);
    prevUp.sub(prevTangent.clone().multiplyScalar(initDot));
    if (prevUp.length() < 0.01) {
      prevUp.set(1, 0, 0);
      const d = prevUp.dot(prevTangent);
      prevUp.sub(prevTangent.clone().multiplyScalar(d));
    }
    prevUp.normalize();
    
    let rollOffset = new THREE.Vector3(0, 0, 0);
    
    for (let pointIdx = 0; pointIdx < numTrackPoints; pointIdx++) {
      const currentPoint = trackPoints[pointIdx];
      const loopSeg = loopMap.get(currentPoint.id);
      
      if (loopSeg) {
        const splineT = pointIdx / totalSplineSegments;
        const entryPos = baseSpline.getPoint(splineT).add(rollOffset.clone());
        const splineTangent = baseSpline.getTangent(splineT).normalize();
        
        const forward = splineTangent.clone();
        
        // Use WORLD up to build roll frame - this keeps the roll horizontal
        // and ensures it goes UP first, not into the ground
        const worldUp = new THREE.Vector3(0, 1, 0);
        let entryUp = worldUp.clone();
        const upDot = entryUp.dot(forward);
        entryUp.sub(forward.clone().multiplyScalar(upDot));
        if (entryUp.length() > 0.001) {
          entryUp.normalize();
        } else {
          // Forward is nearly vertical, use a fallback
          entryUp.set(1, 0, 0);
          const d = entryUp.dot(forward);
          entryUp.sub(forward.clone().multiplyScalar(d)).normalize();
        }
        
        const right = new THREE.Vector3().crossVectors(forward, entryUp).normalize();
        
        const rollFrame: BarrelRollFrame = {
          entryPos,
          forward,
          up: entryUp,
          right,
          radius: loopSeg.radius,
          pitch: loopSeg.pitch
        };
        
        const rollSamples = 64;  // More samples for smooth eased roll
        for (let i = 0; i <= rollSamples; i++) {
          const t = i / rollSamples;
          const sample = sampleVerticalLoopAnalytically(rollFrame, t);
          railData.push({
            point: sample.point,
            tangent: sample.tangent,
            normal: sample.normal,
            up: sample.up,
            tilt: 0
          });
        }
        
        rollOffset.addScaledVector(forward, loopSeg.pitch);
        
        // Exit: tangent should now match forward (since dθ/dt = 0 at t=1)
        prevTangent.copy(forward);  // Exit tangent is forward
        prevUp.copy(entryUp);  // After full rotation, up returns to entry up
      }
      
      if (pointIdx >= numTrackPoints - 1 && !isLooped) continue;
      
      for (let s = 0; s < numSamplesPerSegment; s++) {
        const localT = s / numSamplesPerSegment;
        const globalT = (pointIdx + localT) / totalSplineSegments;
        
        const point = baseSpline.getPoint(globalT).add(rollOffset.clone());
        const tangent = baseSpline.getTangent(globalT).normalize();
        const tilt = interpolateTilt(trackPoints, globalT, isLooped);
        
        let up: THREE.Vector3;
        
        const dot = Math.max(-1, Math.min(1, prevTangent.dot(tangent)));
        if (dot > 0.9999) {
          up = prevUp.clone();
        } else if (dot < -0.9999) {
          up = prevUp.clone();
        } else {
          const axis = new THREE.Vector3().crossVectors(prevTangent, tangent);
          if (axis.length() > 0.0001) {
            axis.normalize();
            const angle = Math.acos(dot);
            const quat = new THREE.Quaternion().setFromAxisAngle(axis, angle);
            up = prevUp.clone().applyQuaternion(quat);
          } else {
            up = prevUp.clone();
          }
        }
        
        const upDot = up.dot(tangent);
        up.sub(tangent.clone().multiplyScalar(upDot));
        if (up.length() > 0.001) {
          up.normalize();
        } else {
          up = prevUp.clone();
        }
        
        prevTangent.copy(tangent);
        prevUp.copy(up);
        
        const normal = new THREE.Vector3().crossVectors(tangent, up).normalize();
        
        railData.push({ point, tangent, normal, up, tilt });
      }
    }
    
    if (!isLooped && trackPoints.length >= 2) {
      const lastPoint = baseSpline.getPoint(1).add(rollOffset);
      const lastTangent = baseSpline.getTangent(1).normalize();
      const lastTilt = trackPoints[trackPoints.length - 1].tilt;
      railData.push({
        point: lastPoint,
        tangent: lastTangent,
        normal: new THREE.Vector3().crossVectors(lastTangent, prevUp).normalize(),
        up: prevUp.clone(),
        tilt: lastTilt
      });
    }
    
    const woodSupports: { pos: THREE.Vector3; tangent: THREE.Vector3; height: number; tilt: number }[] = [];
    const supportInterval = 3;
    
    for (let i = 0; i < railData.length; i += supportInterval) {
      const { point, tangent, tilt } = railData[i];
      if (point.y > 1) {
        woodSupports.push({ 
          pos: point.clone(), 
          tangent: tangent.clone(),
          height: point.y,
          tilt
        });
      }
    }
    
    const trackLights: { pos: THREE.Vector3; normal: THREE.Vector3 }[] = [];
    const lightInterval = 6;
    
    for (let i = 0; i < railData.length; i += lightInterval) {
      const { point, tangent } = railData[i];
      const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
      trackLights.push({ pos: point.clone(), normal: normal.clone() });
    }
    
    return { railData, woodSupports, trackLights };
  }, [trackPoints, loopSegments, isLooped]);
  
  if (railData.length < 2) {
    return null;
  }
  
  const leftRail: [number, number, number][] = [];
  const rightRail: [number, number, number][] = [];
  const railOffset = 0.3;
  
  for (let i = 0; i < railData.length; i++) {
    const { point, normal } = railData[i];
    
    leftRail.push([
      point.x + normal.x * railOffset,
      point.y + normal.y * railOffset,
      point.z + normal.z * railOffset,
    ]);
    rightRail.push([
      point.x - normal.x * railOffset,
      point.y - normal.y * railOffset,
      point.z - normal.z * railOffset,
    ]);
  }
  
  return (
    <group>
      <Line
        points={leftRail}
        color="#ff4444"
        lineWidth={4}
      />
      <Line
        points={rightRail}
        color="#ff4444"
        lineWidth={4}
      />
      
      {railData.filter((_, i) => i % 2 === 0).map((data, i) => {
        const { point, tangent, up } = data;
        
        const right = new THREE.Vector3().crossVectors(tangent, up).normalize();
        const matrix = new THREE.Matrix4().makeBasis(right, up, tangent);
        const euler = new THREE.Euler().setFromRotationMatrix(matrix);
        
        return (
          <mesh
            key={`tie-${i}`}
            position={[point.x, point.y - up.y * 0.08, point.z]}
            rotation={euler}
          >
            <boxGeometry args={[1.0, 0.08, 0.12]} />
            <meshStandardMaterial color="#8B4513" />
          </mesh>
        );
      })}
      
      {showWoodSupports && woodSupports.map((support, i) => {
        const { pos, tangent, height } = support;
        const angle = Math.atan2(tangent.x, tangent.z);
        const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
        
        const legInset = 0.15;
        const leftLegX = pos.x + normal.x * (railOffset - legInset);
        const leftLegZ = pos.z + normal.z * (railOffset - legInset);
        const rightLegX = pos.x - normal.x * (railOffset - legInset);
        const rightLegZ = pos.z - normal.z * (railOffset - legInset);
        
        const crossbraceHeight = height * 0.6;
        const crossLength = Math.sqrt(Math.pow(railOffset * 2, 2) + Math.pow(crossbraceHeight, 2));
        const crossAngle = Math.atan2(crossbraceHeight, railOffset * 2);
        
        return (
          <group key={`wood-${i}`}>
            <mesh position={[leftLegX, height / 2, leftLegZ]}>
              <boxGeometry args={[0.12, height, 0.12]} />
              <meshStandardMaterial color="#8B5A2B" />
            </mesh>
            <mesh position={[rightLegX, height / 2, rightLegZ]}>
              <boxGeometry args={[0.12, height, 0.12]} />
              <meshStandardMaterial color="#8B5A2B" />
            </mesh>
            
            {height > 2 && (
              <>
                <mesh 
                  position={[pos.x, height * 0.3, pos.z]} 
                  rotation={[0, angle, 0]}
                >
                  <boxGeometry args={[0.08, 0.08, railOffset * 2.2]} />
                  <meshStandardMaterial color="#A0522D" />
                </mesh>
                <mesh 
                  position={[pos.x, height * 0.6, pos.z]} 
                  rotation={[0, angle, 0]}
                >
                  <boxGeometry args={[0.08, 0.08, railOffset * 2.2]} />
                  <meshStandardMaterial color="#A0522D" />
                </mesh>
              </>
            )}
            
            {height > 3 && (
              <mesh 
                position={[pos.x, height * 0.45, pos.z]} 
                rotation={[crossAngle, angle, 0]}
              >
                <boxGeometry args={[0.06, crossLength * 0.5, 0.06]} />
                <meshStandardMaterial color="#CD853F" />
              </mesh>
            )}
          </group>
        );
      })}
      
      {isNightMode && trackLights.map((light, i) => {
        const { pos, normal } = light;
        const leftX = pos.x + normal.x * 0.5;
        const leftZ = pos.z + normal.z * 0.5;
        const rightX = pos.x - normal.x * 0.5;
        const rightZ = pos.z - normal.z * 0.5;
        const colors = ["#FF0000", "#FFFF00", "#00FF00", "#00FFFF", "#FF00FF"];
        const color = colors[i % colors.length];
        
        return (
          <group key={`light-${i}`}>
            <mesh position={[leftX, pos.y + 0.1, leftZ]}>
              <sphereGeometry args={[0.3, 6, 6]} />
              <meshBasicMaterial color={color} />
            </mesh>
            <mesh position={[rightX, pos.y + 0.1, rightZ]}>
              <sphereGeometry args={[0.3, 6, 6]} />
              <meshBasicMaterial color={color} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

export function getTrackCurve(trackPoints: { position: THREE.Vector3 }[], isLooped: boolean = false) {
  if (trackPoints.length < 2) return null;
  const points = trackPoints.map((p) => p.position.clone());
  return new THREE.CatmullRomCurve3(points, isLooped, "catmullrom", 0.5);
}

export function getTrackTiltAtProgress(trackPoints: { tilt: number }[], progress: number, isLooped: boolean): number {
  return interpolateTilt(trackPoints, progress, isLooped);
}
