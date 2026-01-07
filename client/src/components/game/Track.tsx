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

function sampleLoopAnalytically(
  segment: LoopSegment,
  theta: number
): { point: THREE.Vector3; tangent: THREE.Vector3; up: THREE.Vector3; normal: THREE.Vector3 } {
  const { entryPos, forward, up, right, radius } = segment;
  
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
  
  return { point, tangent, up: inwardUp, normal: right.clone() };
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
    const numSamplesPerPoint = 20;
    const numTrackPoints = trackPoints.length;
    const totalSplineLength = isLooped ? numTrackPoints : numTrackPoints - 1;
    
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
    
    for (let pointIdx = 0; pointIdx < numTrackPoints; pointIdx++) {
      const currentPoint = trackPoints[pointIdx];
      const loopSeg = loopMap.get(currentPoint.id);
      
      if (loopSeg) {
        const loopSamples = 32;
        for (let i = 0; i <= loopSamples; i++) {
          const theta = (i / loopSamples) * Math.PI * 2;
          const sample = sampleLoopAnalytically(loopSeg, theta);
          railData.push({
            point: sample.point,
            tangent: sample.tangent,
            normal: sample.normal,
            up: sample.up,
            tilt: 0
          });
          prevTangent.copy(sample.tangent);
          prevUp.copy(sample.up);
        }
      } else {
        const nextIdx = isLooped ? (pointIdx + 1) % numTrackPoints : Math.min(pointIdx + 1, numTrackPoints - 1);
        if (pointIdx >= numTrackPoints - 1 && !isLooped) continue;
        
        const samplesInSegment = numSamplesPerPoint;
        for (let s = 0; s < samplesInSegment; s++) {
          const localT = s / samplesInSegment;
          const globalT = (pointIdx + localT) / totalSplineLength;
          
          const point = baseSpline.getPoint(globalT);
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
    }
    
    if (!isLooped && trackPoints.length >= 2) {
      const lastPoint = baseSpline.getPoint(1);
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
    const { point, tilt, normal } = railData[i];
    
    const tiltRad = (tilt * Math.PI) / 180;
    const tiltCos = Math.cos(tiltRad);
    const tiltSin = Math.sin(tiltRad);
    
    const leftYOffset = railOffset * tiltSin;
    const rightYOffset = -railOffset * tiltSin;
    const horizontalScale = tiltCos;
    
    leftRail.push([
      point.x + normal.x * railOffset * horizontalScale,
      point.y + leftYOffset,
      point.z + normal.z * railOffset * horizontalScale,
    ]);
    rightRail.push([
      point.x - normal.x * railOffset * horizontalScale,
      point.y + rightYOffset,
      point.z - normal.z * railOffset * horizontalScale,
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
        const { point, tangent, tilt } = data;
        const angle = Math.atan2(tangent.x, tangent.z);
        const tiltRad = (tilt * Math.PI) / 180;
        
        return (
          <mesh
            key={`tie-${i}`}
            position={[point.x, point.y - 0.08, point.z]}
            rotation={[tiltRad, angle, 0]}
          >
            <boxGeometry args={[1.0, 0.08, 0.12]} />
            <meshStandardMaterial color="#8B4513" />
          </mesh>
        );
      })}
      
      {showWoodSupports && woodSupports.map((support, i) => {
        const { pos, tangent, height, tilt } = support;
        const angle = Math.atan2(tangent.x, tangent.z);
        const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
        
        const tiltRad = (tilt * Math.PI) / 180;
        const tiltCos = Math.cos(tiltRad);
        const tiltSin = Math.sin(tiltRad);
        
        const leftX = pos.x + normal.x * railOffset * tiltCos;
        const leftY = pos.y + railOffset * tiltSin;
        const leftZ = pos.z + normal.z * railOffset * tiltCos;
        const rightX = pos.x - normal.x * railOffset * tiltCos;
        const rightY = pos.y - railOffset * tiltSin;
        const rightZ = pos.z - normal.z * railOffset * tiltCos;
        
        const leftHeight = leftY;
        const rightHeight = rightY;
        
        const legInset = 0.15;
        const leftLegX = pos.x + normal.x * (railOffset - legInset) * tiltCos;
        const leftLegZ = pos.z + normal.z * (railOffset - legInset) * tiltCos;
        const rightLegX = pos.x - normal.x * (railOffset - legInset) * tiltCos;
        const rightLegZ = pos.z - normal.z * (railOffset - legInset) * tiltCos;
        
        const crossbraceHeight = height * 0.6;
        const crossLength = Math.sqrt(Math.pow(railOffset * 2, 2) + Math.pow(crossbraceHeight, 2));
        const crossAngle = Math.atan2(crossbraceHeight, railOffset * 2);
        
        return (
          <group key={`wood-${i}`}>
            <mesh position={[leftLegX, leftHeight / 2, leftLegZ]}>
              <boxGeometry args={[0.12, leftHeight, 0.12]} />
              <meshStandardMaterial color="#8B5A2B" />
            </mesh>
            <mesh position={[rightLegX, rightHeight / 2, rightLegZ]}>
              <boxGeometry args={[0.12, rightHeight, 0.12]} />
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
