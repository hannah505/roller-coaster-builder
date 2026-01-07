import { create } from "zustand";
import * as THREE from "three";

export type CoasterMode = "build" | "ride" | "preview";

// Loop segment descriptor - stored separately from track points
export interface LoopSegment {
  id: string;
  entryPointId: string;  // ID of track point where loop starts
  entryPos: THREE.Vector3;
  forward: THREE.Vector3;  // Direction entering the loop
  up: THREE.Vector3;
  right: THREE.Vector3;
  radius: number;
}

export interface TrackPoint {
  id: string;
  position: THREE.Vector3;
  tilt: number;
  hasLoop?: boolean;  // True if a loop starts at this point
}

// Serializable versions for JSON storage
interface SerializedLoopSegment {
  id: string;
  entryPointId: string;
  entryPos: [number, number, number];
  forward: [number, number, number];
  up: [number, number, number];
  right: [number, number, number];
  radius: number;
}

interface SerializedTrackPoint {
  id: string;
  position: [number, number, number];
  tilt: number;
  hasLoop?: boolean;
}

export interface SavedCoaster {
  id: string;
  name: string;
  timestamp: number;
  trackPoints: SerializedTrackPoint[];
  loopSegments: SerializedLoopSegment[];
  isLooped: boolean;
  hasChainLift: boolean;
  showWoodSupports: boolean;
}

// Serialization helpers
function serializeVector3(v: THREE.Vector3): [number, number, number] {
  return [v.x, v.y, v.z];
}

function deserializeVector3(arr: [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(arr[0], arr[1], arr[2]);
}

function serializeTrackPoint(point: TrackPoint): SerializedTrackPoint {
  return {
    id: point.id,
    position: serializeVector3(point.position),
    tilt: point.tilt,
    hasLoop: point.hasLoop,
  };
}

function deserializeTrackPoint(serialized: SerializedTrackPoint): TrackPoint {
  return {
    id: serialized.id,
    position: deserializeVector3(serialized.position),
    tilt: serialized.tilt,
    hasLoop: serialized.hasLoop,
  };
}

function serializeLoopSegment(segment: LoopSegment): SerializedLoopSegment {
  return {
    id: segment.id,
    entryPointId: segment.entryPointId,
    entryPos: serializeVector3(segment.entryPos),
    forward: serializeVector3(segment.forward),
    up: serializeVector3(segment.up),
    right: serializeVector3(segment.right),
    radius: segment.radius,
  };
}

function deserializeLoopSegment(serialized: SerializedLoopSegment): LoopSegment {
  return {
    id: serialized.id,
    entryPointId: serialized.entryPointId,
    entryPos: deserializeVector3(serialized.entryPos),
    forward: deserializeVector3(serialized.forward),
    up: deserializeVector3(serialized.up),
    right: deserializeVector3(serialized.right),
    radius: serialized.radius,
  };
}

const STORAGE_KEY = "roller_coaster_saves";

function loadSavedCoasters(): SavedCoaster[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

function persistSavedCoasters(coasters: SavedCoaster[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(coasters));
}

interface RollerCoasterState {
  mode: CoasterMode;
  trackPoints: TrackPoint[];
  loopSegments: LoopSegment[];
  selectedPointId: string | null;
  rideProgress: number;
  isRiding: boolean;
  rideSpeed: number;
  isDraggingPoint: boolean;
  isAddingPoints: boolean;
  isLooped: boolean;
  hasChainLift: boolean;
  showWoodSupports: boolean;
  isNightMode: boolean;
  cameraTarget: THREE.Vector3 | null;
  savedCoasters: SavedCoaster[];
  currentCoasterName: string | null;
  
  setMode: (mode: CoasterMode) => void;
  setCameraTarget: (target: THREE.Vector3 | null) => void;
  addTrackPoint: (position: THREE.Vector3) => void;
  updateTrackPoint: (id: string, position: THREE.Vector3) => void;
  updateTrackPointTilt: (id: string, tilt: number) => void;
  removeTrackPoint: (id: string) => void;
  createLoopAtPoint: (id: string) => void;
  selectPoint: (id: string | null) => void;
  clearTrack: () => void;
  setRideProgress: (progress: number) => void;
  setIsRiding: (riding: boolean) => void;
  setRideSpeed: (speed: number) => void;
  setIsDraggingPoint: (dragging: boolean) => void;
  setIsAddingPoints: (adding: boolean) => void;
  setIsLooped: (looped: boolean) => void;
  setHasChainLift: (hasChain: boolean) => void;
  setShowWoodSupports: (show: boolean) => void;
  setIsNightMode: (night: boolean) => void;
  startRide: () => void;
  stopRide: () => void;
  
  // Save/Load functionality
  saveCoaster: (name: string) => void;
  loadCoaster: (id: string) => void;
  deleteCoaster: (id: string) => void;
  exportCoaster: (id: string) => string | null;
  importCoaster: (jsonString: string) => boolean;
  refreshSavedCoasters: () => void;
}

let pointCounter = 0;

export const useRollerCoaster = create<RollerCoasterState>((set, get) => ({
  mode: "build",
  trackPoints: [],
  loopSegments: [],
  selectedPointId: null,
  rideProgress: 0,
  isRiding: false,
  rideSpeed: 1.0,
  isDraggingPoint: false,
  isAddingPoints: true,
  isLooped: false,
  hasChainLift: true,
  showWoodSupports: false,
  isNightMode: false,
  cameraTarget: null,
  savedCoasters: loadSavedCoasters(),
  currentCoasterName: null,
  
  setMode: (mode) => set({ mode }),
  
  setCameraTarget: (target) => set({ cameraTarget: target }),
  
  setIsDraggingPoint: (dragging) => set({ isDraggingPoint: dragging }),
  
  setIsAddingPoints: (adding) => set({ isAddingPoints: adding }),
  
  setIsLooped: (looped) => set({ isLooped: looped }),
  
  setHasChainLift: (hasChain) => set({ hasChainLift: hasChain }),
  
  setShowWoodSupports: (show) => set({ showWoodSupports: show }),
  
  setIsNightMode: (night) => set({ isNightMode: night }),
  
  addTrackPoint: (position) => {
    const id = `point-${++pointCounter}`;
    set((state) => ({
      trackPoints: [...state.trackPoints, { id, position: position.clone(), tilt: 0 }],
    }));
  },
  
  updateTrackPoint: (id, position) => {
    set((state) => ({
      trackPoints: state.trackPoints.map((point) =>
        point.id === id ? { ...point, position: position.clone() } : point
      ),
    }));
  },
  
  updateTrackPointTilt: (id, tilt) => {
    set((state) => ({
      trackPoints: state.trackPoints.map((point) =>
        point.id === id ? { ...point, tilt } : point
      ),
    }));
  },
  
  removeTrackPoint: (id) => {
    set((state) => ({
      trackPoints: state.trackPoints.filter((point) => point.id !== id),
      selectedPointId: state.selectedPointId === id ? null : state.selectedPointId,
    }));
  },
  
  createLoopAtPoint: (id) => {
    set((state) => {
      const pointIndex = state.trackPoints.findIndex((p) => p.id === id);
      if (pointIndex === -1) return state;
      
      // Check if this point already has a loop
      const entryPoint = state.trackPoints[pointIndex];
      if (entryPoint.hasLoop) return state;
      
      const entryPos = entryPoint.position.clone();
      
      // Calculate forward direction from neighboring points
      let forward = new THREE.Vector3(1, 0, 0);
      if (pointIndex > 0) {
        const prevPoint = state.trackPoints[pointIndex - 1];
        forward = entryPos.clone().sub(prevPoint.position);
        forward.y = 0;  // Keep loop vertical
        if (forward.length() < 0.1) {
          forward = new THREE.Vector3(1, 0, 0);
        }
        forward.normalize();
      }
      
      const loopRadius = 5;
      const up = new THREE.Vector3(0, 1, 0);
      const right = new THREE.Vector3().crossVectors(forward, up).normalize();
      
      // Create loop segment descriptor (NO points inserted into track)
      const loopSegment: LoopSegment = {
        id: `loop-${Date.now()}`,
        entryPointId: id,
        entryPos: entryPos.clone(),
        forward: forward.clone(),
        up: up.clone(),
        right: right.clone(),
        radius: loopRadius,
      };
      
      // Mark the track point as having a loop
      const newTrackPoints = state.trackPoints.map((p) =>
        p.id === id ? { ...p, hasLoop: true } : p
      );
      
      return {
        trackPoints: newTrackPoints,
        loopSegments: [...state.loopSegments, loopSegment],
      };
    });
  },
  
  selectPoint: (id) => set({ selectedPointId: id }),
  
  clearTrack: () => {
    set({ trackPoints: [], loopSegments: [], selectedPointId: null, rideProgress: 0, isRiding: false });
  },
  
  setRideProgress: (progress) => set({ rideProgress: progress }),
  
  setIsRiding: (riding) => set({ isRiding: riding }),
  
  setRideSpeed: (speed) => set({ rideSpeed: speed }),
  
  startRide: () => {
    const { trackPoints } = get();
    if (trackPoints.length >= 2) {
      set({ mode: "ride", isRiding: true, rideProgress: 0 });
    }
  },
  
  stopRide: () => {
    set({ mode: "build", isRiding: false, rideProgress: 0 });
  },
  
  // Save/Load functionality
  saveCoaster: (name: string) => {
    const state = get();
    const id = `coaster-${Date.now()}`;
    const savedCoaster: SavedCoaster = {
      id,
      name,
      timestamp: Date.now(),
      trackPoints: state.trackPoints.map(serializeTrackPoint),
      loopSegments: state.loopSegments.map(serializeLoopSegment),
      isLooped: state.isLooped,
      hasChainLift: state.hasChainLift,
      showWoodSupports: state.showWoodSupports,
    };
    
    const coasters = loadSavedCoasters();
    coasters.push(savedCoaster);
    persistSavedCoasters(coasters);
    
    set({ savedCoasters: coasters, currentCoasterName: name });
  },
  
  loadCoaster: (id: string) => {
    try {
      const coasters = loadSavedCoasters();
      const coaster = coasters.find(c => c.id === id);
      if (!coaster || !Array.isArray(coaster.trackPoints)) return;
      
      const trackPoints = coaster.trackPoints.map(deserializeTrackPoint);
      const loopSegments = (coaster.loopSegments || []).map(deserializeLoopSegment);
      
      // Update pointCounter to avoid ID collisions
      const maxId = trackPoints.reduce((max, p) => {
        const num = parseInt(p.id.replace('point-', ''), 10);
        return isNaN(num) ? max : Math.max(max, num);
      }, 0);
      pointCounter = maxId;
      
      set({
        trackPoints,
        loopSegments,
        isLooped: Boolean(coaster.isLooped),
        hasChainLift: coaster.hasChainLift !== false,
        showWoodSupports: Boolean(coaster.showWoodSupports),
        currentCoasterName: coaster.name || "Untitled",
        selectedPointId: null,
        rideProgress: 0,
        isRiding: false,
        mode: "build",
      });
    } catch (e) {
      console.error("Failed to load coaster:", e);
    }
  },
  
  deleteCoaster: (id: string) => {
    const coasters = loadSavedCoasters().filter(c => c.id !== id);
    persistSavedCoasters(coasters);
    set({ savedCoasters: coasters });
  },
  
  exportCoaster: (id: string) => {
    const coasters = loadSavedCoasters();
    const coaster = coasters.find(c => c.id === id);
    if (!coaster) return null;
    return JSON.stringify(coaster, null, 2);
  },
  
  importCoaster: (jsonString: string) => {
    try {
      const coaster = JSON.parse(jsonString);
      
      // Validate required fields
      if (!coaster || typeof coaster !== 'object') return false;
      if (typeof coaster.name !== 'string' || !coaster.name.trim()) return false;
      if (!Array.isArray(coaster.trackPoints)) return false;
      
      // Validate each track point has required structure
      for (const pt of coaster.trackPoints) {
        if (!pt || typeof pt !== 'object') return false;
        if (!Array.isArray(pt.position) || pt.position.length !== 3) return false;
        if (!pt.position.every((n: unknown) => typeof n === 'number' && isFinite(n))) return false;
        if (typeof pt.tilt !== 'number') return false;
        if (typeof pt.id !== 'string') return false;
        
        // Validate loopMeta if present
        if (pt.loopMeta) {
          const lm = pt.loopMeta;
          if (!Array.isArray(lm.entryPos) || lm.entryPos.length !== 3) return false;
          if (!Array.isArray(lm.forward) || lm.forward.length !== 3) return false;
          if (!Array.isArray(lm.up) || lm.up.length !== 3) return false;
          if (!Array.isArray(lm.right) || lm.right.length !== 3) return false;
          if (typeof lm.radius !== 'number' || typeof lm.theta !== 'number') return false;
        }
      }
      
      // Assign new ID to avoid conflicts
      const validCoaster: SavedCoaster = {
        id: `coaster-${Date.now()}`,
        name: coaster.name.trim(),
        timestamp: Date.now(),
        trackPoints: coaster.trackPoints,
        isLooped: Boolean(coaster.isLooped),
        hasChainLift: coaster.hasChainLift !== false,
        showWoodSupports: Boolean(coaster.showWoodSupports),
      };
      
      const coasters = loadSavedCoasters();
      coasters.push(validCoaster);
      persistSavedCoasters(coasters);
      set({ savedCoasters: coasters });
      return true;
    } catch {
      return false;
    }
  },
  
  refreshSavedCoasters: () => {
    set({ savedCoasters: loadSavedCoasters() });
  },
}));
