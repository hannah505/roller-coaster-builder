import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useRollerCoaster } from "@/lib/stores/useRollerCoaster";
import { getTrackCurve } from "./Track";
import {
  CAR_WIDTH, CAR_HEIGHT, CAR_LENGTH, CAR_OFFSET_Y,
  CABIN_WIDTH, CABIN_HEIGHT, CABIN_LENGTH, CABIN_OFFSET_Y,
  WHEEL_RADIUS, WHEEL_WIDTH, WHEEL_OFFSET_Y, WHEEL_OFFSET_Z, WHEEL_OFFSET_X
} from "@/lib/config/scale";

export function CoasterCar() {
  const meshRef = useRef<THREE.Group>(null);
  const { trackPoints, rideProgress, isRiding, mode } = useRollerCoaster();
  
  useFrame(() => {
    if (!meshRef.current || !isRiding) return;
    
    const curve = getTrackCurve(trackPoints);
    if (!curve) return;
    
    const position = curve.getPoint(rideProgress);
    const tangent = curve.getTangent(rideProgress);
    
    meshRef.current.position.copy(position);
    meshRef.current.position.y -= CAR_OFFSET_Y;
    
    const angle = Math.atan2(tangent.x, tangent.z);
    meshRef.current.rotation.y = angle;
    
    const pitch = Math.asin(-tangent.y);
    meshRef.current.rotation.x = pitch;
  });
  
  // Hide the cart entirely during first-person ride view
  // The rider is sitting in the cart, so they shouldn't see it
  if (mode === "ride") return null;
  
  // Show cart in build mode when not riding
  if (!isRiding) return null;
  
  return (
    <group ref={meshRef}>
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[CAR_WIDTH, CAR_HEIGHT, CAR_LENGTH]} />
        <meshStandardMaterial color="#ff0000" metalness={0.7} roughness={0.3} />
      </mesh>
      <mesh position={[0, CABIN_OFFSET_Y, -CABIN_LENGTH / 2]}>
        <boxGeometry args={[CABIN_WIDTH, CABIN_HEIGHT, CABIN_LENGTH]} />
        <meshStandardMaterial color="#333333" />
      </mesh>
      <mesh position={[-WHEEL_OFFSET_X, -WHEEL_OFFSET_Y, WHEEL_OFFSET_Z]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[WHEEL_RADIUS, WHEEL_RADIUS, WHEEL_WIDTH, 16]} />
        <meshStandardMaterial color="#222222" metalness={0.8} />
      </mesh>
      <mesh position={[WHEEL_OFFSET_X, -WHEEL_OFFSET_Y, WHEEL_OFFSET_Z]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[WHEEL_RADIUS, WHEEL_RADIUS, WHEEL_WIDTH, 16]} />
        <meshStandardMaterial color="#222222" metalness={0.8} />
      </mesh>
      <mesh position={[-WHEEL_OFFSET_X, -WHEEL_OFFSET_Y, -WHEEL_OFFSET_Z]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[WHEEL_RADIUS, WHEEL_RADIUS, WHEEL_WIDTH, 16]} />
        <meshStandardMaterial color="#222222" metalness={0.8} />
      </mesh>
      <mesh position={[WHEEL_OFFSET_X, -WHEEL_OFFSET_Y, -WHEEL_OFFSET_Z]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[WHEEL_RADIUS, WHEEL_RADIUS, WHEEL_WIDTH, 16]} />
        <meshStandardMaterial color="#222222" metalness={0.8} />
      </mesh>
    </group>
  );
}
