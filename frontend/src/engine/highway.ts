import * as THREE from 'three';
import type { ChartData, ChartMeasure, ChartNote } from '../types/chart';
import {
  DEFAULT_HIGHWAY_CONFIG,
  MIN_DYNAMIC_FRET_COUNT,
  STRING_RAILS,
  computeActiveHandPosition,
  computeDynamicFretboardConfig,
  durationToWorldZ,
  extractChordClusters,
  fretToWorldX,
  fretWireToWorldX,
  getStringRailSpec,
  isNoteActiveAtHitBar,
  isZVisible,
  normalizeSpeedUnitsPerSec,
  projectTimeToZ,
  stringToWorldY,
  type ChordCluster,
  type HighwayConfig,
} from './coordinates';
import { ParticleSystem } from './particles';
import {
  ScoringEngine,
  type HitEvaluationResult,
  type MissedNoteEvent,
  type ScoreState,
} from './scoring';

export {
  DEFAULT_HIGHWAY_CONFIG,
  MIN_DYNAMIC_FRET_COUNT,
  STRING_RAILS,
  computeActiveHandPosition,
  computeDynamicFretboardConfig,
  durationToWorldZ,
  extractChordClusters,
  fretToWorldX,
  fretWireToWorldX,
  getStringRailSpec,
  isNoteActiveAtHitBar,
  isZVisible,
  normalizeSpeedUnitsPerSec,
  projectTimeToZ,
  stringToWorldY,
  type ChordCluster,
  type HighwayConfig,
};

export interface HighwayCallbacks {
  onNoteHit?: (result: HitEvaluationResult) => void;
  onNoteMiss?: (miss: MissedNoteEvent) => void;
}

interface NoteRenderObject {
  note: ChartNote;
  index: number;
  baseX: number;
  fretboardY: number;
  highwayLaneOffset: number;
  originalColorHex: number;
  isDesaturatedMissed: boolean;
  // 3D highway note group (travels along the elevated -Z highway ramp)
  highwayGroup: THREE.Group;
  hwGemMat: THREE.MeshStandardMaterial;
  tailMesh: THREE.Mesh;
  tailMat: THREE.MeshBasicMaterial;
  stemLine: THREE.Line;
  stemMat: THREE.LineBasicMaterial;
  hwSpriteMat: THREE.SpriteMaterial;
  // Target fretboard note group (pinned on its exact colored string rail at Z=0)
  fretboardNoteGroup: THREE.Group;
  fbGemMesh: THREE.Mesh;
  fbGemMaterial: THREE.MeshStandardMaterial;
}

interface ChordClusterRenderObject {
  cluster: ChordCluster;
  baseX: number;
  group: THREE.Group;
  wireframe: THREE.LineSegments;
  boxMat: THREE.MeshBasicMaterial;
}

interface BeatLineRenderObject {
  timeMs: number;
  isMeasureStart: boolean;
  measureNumber?: number;
  group: THREE.Group;
}

/** Standard fret markers shown below the target fretboard */
const STANDARD_FRET_LABELS = new Set([1, 2, 3, 5, 7, 9, 12, 15, 17, 19, 21, 24, 27, 30]);

/** Upward slope (dY / d(-Z)) of the highway ramp starting from the top edge of the target fretboard */
const HIGHWAY_SLOPE_Y = 0.22;

export class HighwayEngine {
  private readonly container: HTMLElement;
  private readonly baseConfig: HighwayConfig;
  private config: HighwayConfig;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;

  private readonly backdropGroup = new THREE.Group();
  private readonly fretboardGroup = new THREE.Group();
  private readonly highwayRampGroup = new THREE.Group();
  private readonly measuresGroup = new THREE.Group();
  private readonly notesGroup = new THREE.Group();
  private readonly fretboardNotesGroup = new THREE.Group();
  private readonly chordsGroup = new THREE.Group();

  private readonly fretLabelSprites: Map<number, THREE.Sprite> = new Map();
  private readonly stringRailMaterials: Map<
    number,
    THREE.MeshStandardMaterial
  > = new Map();
  private readonly stringRailMeshes: Map<number, THREE.Mesh> = new Map();
  private readonly stringRailPulses: Map<number, number> = new Map();

  public readonly scoring = new ScoringEngine();
  private readonly particles = new ParticleSystem();
  private callbacks: HighwayCallbacks = {};

  // Active 4-fret hand position bracket on the pinned fretboard & highway
  private handBracketGroup = new THREE.Group();
  private handBracketCurrentX = 0;
  private handBracketTargetX = 0;
  private activeHandFrets: { startFret: number; endFret: number } = {
    startFret: 1,
    endFret: 4,
  };
  private lastHighlightedHandKey = '';

  private highwayStartY = 1.62;

  private chartNotes: ChartNote[] = [];
  private chartMeasures: ChartMeasure[] = [];
  private noteObjects: NoteRenderObject[] = [];
  private chordObjects: ChordClusterRenderObject[] = [];
  private beatLineObjects: BeatLineRenderObject[] = [];
  private badgeTextureCache: Map<string, THREE.CanvasTexture> = new Map();
  private chordLabelCache: Map<string, THREE.CanvasTexture> = new Map();
  private fretLabelTextureCache: Map<string, THREE.CanvasTexture> = new Map();

  private currentAudioTimeMs = 0;
  private baseSpeedAt120Bpm: number;
  private currentBpm = 120;
  private speed: number;
  private activeNotesAtHitBar: ChartNote[] = [];

  private readonly handleResizeBound: () => void;

  constructor(
    container: HTMLElement,
    config: Partial<HighwayConfig> = {},
    callbacks: HighwayCallbacks = {},
  ) {
    this.container = container;
    this.baseConfig = { ...DEFAULT_HIGHWAY_CONFIG, ...config };
    this.config = { ...this.baseConfig };
    this.callbacks = callbacks;
    this.baseSpeedAt120Bpm = normalizeSpeedUnitsPerSec(
      this.config.speed ?? this.config.speedMultiplier,
    );
    this.speed = this.baseSpeedAt120Bpm;

    const y1 = stringToWorldY(1, this.config);
    const y6 = stringToWorldY(6, this.config);
    this.highwayStartY = Math.max(y1, y6) + 0.18;

    // 1. Scene Setup
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x060911);
    this.scene.fog = new THREE.FogExp2(0x060911, 0.016);

    // 2. Yousician Perspective Camera framing the Target Fretboard at bottom and Highway above it
    const width = Math.max(1, container.clientWidth || window.innerWidth);
    const height = Math.max(1, container.clientHeight || window.innerHeight);
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 150);
    this.camera.position.set(5.0, 3.8, 6.5);
    this.camera.lookAt(5.0, 1.35, -10.0);

    // 3. WebGLRenderer
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.container.appendChild(this.renderer.domElement);

    // 4. Build Scene Lighting, Backdrop, Target Fretboard (Z=0), and -Z Highway
    this.setupLights();
    this.buildYousicianBackdrop();
    this.buildPinnedFretboardTargetBar();
    this.buildPerspectiveHighwayRamp();

    this.scene.add(this.backdropGroup);
    this.scene.add(this.highwayRampGroup);
    this.scene.add(this.measuresGroup);
    this.scene.add(this.chordsGroup);
    this.scene.add(this.notesGroup);
    this.scene.add(this.fretboardGroup);
    this.scene.add(this.fretboardNotesGroup);
    this.scene.add(this.particles.group);

    // 5. Window Resize Listener
    this.handleResizeBound = () => this.onWindowResize();
    window.addEventListener('resize', this.handleResizeBound);
  }

  public setCallbacks(callbacks: HighwayCallbacks): void {
    this.callbacks = callbacks;
  }

  private setupLights(): void {
    const ambientLight = new THREE.AmbientLight(0xe2e8f0, 0.95);
    this.scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.35);
    keyLight.position.set(5.0, 12.0, 10.0);
    this.scene.add(keyLight);

    const fretboardGlow = new THREE.PointLight(0x38bdf8, 1.2, 24, 1.4);
    fretboardGlow.position.set(5.0, 1.5, 3.0);
    this.scene.add(fretboardGlow);
  }

  /**
   * Computes the highway floor Y coordinate for a given world Z (z <= 0).
   * Starts at the top edge of the target fretboard at Z=0 and slopes upward into -Z
   * so the highway never passes behind the target fretboard strings.
   */
  private getHighwayFloorY(worldZ: number): number {
    const dist = Math.max(0, -worldZ);
    return this.highwayStartY + dist * HIGHWAY_SLOPE_Y;
  }

  /**
   * Builds the subtle Yousician-style particle wave nebula backdrop on the left & right flanks.
   */
  private buildYousicianBackdrop(): void {
    const positions: number[] = [];
    const colors: number[] = [];
    const cLeft = new THREE.Color(0x0ea5e9);
    const cRight = new THREE.Color(0xf97316);

    for (const side of [-1, 1]) {
      for (let i = 0; i < 26; i++) {
        for (let j = 0; j < 16; j++) {
          const u = i / 25;
          const v = j / 15;
          const x = 5.0 + side * (6.2 + u * 10.5);
          const z = -3.0 - v * 32.0;
          const wave =
            Math.sin(u * Math.PI * 2.2 + v * 3.5) * 1.2 +
            Math.cos(v * Math.PI * 2.0) * 0.7;
          const y = 2.6 + wave + v * 4.5;
          positions.push(x, y, z);

          const col = side < 0 ? cLeft : cRight;
          colors.push(col.r, col.g, col.b);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.13,
      vertexColors: true,
      transparent: true,
      opacity: 0.32,
    });
    this.backdropGroup.add(new THREE.Points(geo, mat));
  }

  private isStandardFretLabel(f: number): boolean {
    return STANDARD_FRET_LABELS.has(f) || f === this.config.maxFret;
  }

  private rebuildFretboardAndHighway(): void {
    while (this.fretboardGroup.children.length > 0) {
      this.fretboardGroup.remove(this.fretboardGroup.children[0]);
    }
    while (this.highwayRampGroup.children.length > 0) {
      this.highwayRampGroup.remove(this.highwayRampGroup.children[0]);
    }
    this.handBracketGroup = new THREE.Group();
    this.fretLabelSprites.clear();
    this.stringRailMaterials.clear();
    this.stringRailMeshes.clear();
    this.stringRailPulses.clear();
    this.lastHighlightedHandKey = '';

    this.buildPinnedFretboardTargetBar();
    this.buildPerspectiveHighwayRamp();
  }

  /**
   * Builds the Target Fretboard at Z = 0:
   * - 6 horizontal colored rails spanning X (Frets 0 to maxFret), String 6 (Low E Red) on top down to String 1 (High E Purple) on bottom.
   * - Vertical metallic fret wires for frets 0 to maxFret spaced along X, with numeric labels below.
   * - Active hand position bracket: Highlighted green outline bounding the active 4-fret region.
   */
  private buildPinnedFretboardTargetBar(): void {
    const nutX = fretWireToWorldX(0, this.config);
    const maxWireX = fretWireToWorldX(this.config.maxFret, this.config);
    const boardWidth = maxWireX - nutX + 0.35;
    const boardCenterX = (nutX + maxWireX) / 2 + 0.08;

    const y1 = stringToWorldY(1, this.config);
    const y6 = stringToWorldY(6, this.config);
    const bottomStringY = Math.min(y1, y6);
    const topStringY = Math.max(y1, y6);
    const boardCenterY = (bottomStringY + topStringY) / 2;
    const boardHeight = topStringY - bottomStringY + 0.32;

    // Solid dark fretboard backing slab at Z = 0
    const boardGeo = new THREE.BoxGeometry(boardWidth, boardHeight, 0.1);
    const boardMat = new THREE.MeshStandardMaterial({
      color: 0x0b0f19,
      roughness: 0.65,
      metalness: 0.2,
    });
    const boardMesh = new THREE.Mesh(boardGeo, boardMat);
    boardMesh.position.set(boardCenterX, boardCenterY, -0.06);
    this.fretboardGroup.add(boardMesh);

    // Sculpted maple guitar neck/headstock end piece to the left of Fret 0
    const neckWidth = 1.45;
    const neckGeo = new THREE.CylinderGeometry(
      boardHeight * 0.54,
      boardHeight * 0.64,
      neckWidth,
      20,
    );
    neckGeo.rotateZ(Math.PI / 2);
    neckGeo.scale(1, 1, 0.35);
    const neckMat = new THREE.MeshStandardMaterial({
      color: 0xd4a373,
      roughness: 0.48,
      metalness: 0.08,
    });
    const neckMesh = new THREE.Mesh(neckGeo, neckMat);
    neckMesh.position.set(nutX - neckWidth / 2 - 0.03, boardCenterY, -0.02);
    this.fretboardGroup.add(neckMesh);

    // Vertical metallic fret wires for frets 0 (nut) to 15 spaced along X
    const nutWireGeo = new THREE.BoxGeometry(0.09, boardHeight + 0.04, 0.13);
    const nutWireMat = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      roughness: 0.25,
      metalness: 0.3,
    });

    const fretWireGeo = new THREE.CylinderGeometry(
      0.018,
      0.018,
      boardHeight,
      10,
    );
    const fretWireMat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      roughness: 0.25,
      metalness: 0.85,
    });

    for (let f = 0; f <= this.config.maxFret; f++) {
      const wireX = fretWireToWorldX(f, this.config);
      const wireMesh = new THREE.Mesh(
        f === 0 ? nutWireGeo : fretWireGeo,
        f === 0 ? nutWireMat : fretWireMat,
      );
      wireMesh.position.set(wireX, boardCenterY, 0);
      this.fretboardGroup.add(wireMesh);

      if (f >= 1) {
        const slotCenterX = fretToWorldX(f, this.config);
        const isStandardLabel = this.isStandardFretLabel(f);
        const fretSprite = this.createFretNumberSprite(
          String(f),
          isStandardLabel ? 'standard' : 'dim',
        );
        fretSprite.position.set(slotCenterX, bottomStringY - 0.31, 0.05);
        fretSprite.visible = isStandardLabel;
        this.fretboardGroup.add(fretSprite);
        this.fretLabelSprites.set(f, fretSprite);
      }
    }

    // 6 stagnant horizontal colored string rails spanning X (Frets 0 to 15)
    for (const railSpec of STRING_RAILS) {
      const y = stringToWorldY(railSpec.stringNumber, this.config);
      const strGeo = new THREE.CylinderGeometry(
        railSpec.radius,
        railSpec.radius,
        boardWidth,
        12,
      );
      strGeo.rotateZ(Math.PI / 2);

      const strMat = new THREE.MeshStandardMaterial({
        color: railSpec.colorHex,
        emissive: railSpec.colorHex,
        emissiveIntensity: 0.55,
        roughness: 0.25,
        metalness: 0.6,
      });
      const strMesh = new THREE.Mesh(strGeo, strMat);
      strMesh.position.set(boardCenterX, y, 0.02);
      this.fretboardGroup.add(strMesh);
      this.stringRailMaterials.set(railSpec.stringNumber, strMat);
      this.stringRailMeshes.set(railSpec.stringNumber, strMesh);
      this.stringRailPulses.set(railSpec.stringNumber, 0);
    }

    // Active 4-Fret Hand Position Bracket (highlighted green outline on fretboard + sloped side rails on highway)
    const bracketWidth = this.config.fretSpacingX * 4;
    const bracketHeight = boardHeight + 0.1;

    const bracketFillGeo = new THREE.PlaneGeometry(bracketWidth, bracketHeight);
    const bracketFillMat = new THREE.MeshBasicMaterial({
      color: 0x4caf50,
      transparent: true,
      opacity: 0.1,
      side: THREE.DoubleSide,
    });
    const bracketFill = new THREE.Mesh(bracketFillGeo, bracketFillMat);
    bracketFill.position.set(0, boardCenterY, 0);
    this.handBracketGroup.add(bracketFill);

    const bracketBoxGeo = new THREE.BoxGeometry(
      bracketWidth,
      bracketHeight,
      0.08,
    );
    const bracketEdges = new THREE.EdgesGeometry(bracketBoxGeo);
    const bracketLineMat = new THREE.LineBasicMaterial({
      color: 0x4ade80,
      transparent: true,
      opacity: 0.92,
    });
    const bracketWire = new THREE.LineSegments(bracketEdges, bracketLineMat);
    bracketWire.position.set(0, boardCenterY, 0);
    this.handBracketGroup.add(bracketWire);

    // Glowing green highway side rails starting at the top of the bracket and sloping up the highway into -Z
    const maxDist = this.config.highwayLengthDist;
    const farY = this.getHighwayFloorY(-maxDist);
    for (const sign of [-1, 1]) {
      const railX = sign * (bracketWidth / 2);
      const points = [
        new THREE.Vector3(railX, this.highwayStartY, 0),
        new THREE.Vector3(railX, farY, -maxDist),
      ];
      const railGeo = new THREE.BufferGeometry().setFromPoints(points);
      const railMat = new THREE.LineBasicMaterial({
        color: 0x4ade80,
        transparent: true,
        opacity: 0.85,
      });
      this.handBracketGroup.add(new THREE.Line(railGeo, railMat));
    }

    this.handBracketCurrentX = this.computeBracketCenterX(1);
    this.handBracketTargetX = this.handBracketCurrentX;
    this.handBracketGroup.position.set(this.handBracketCurrentX, 0, 0.03);
    this.fretboardGroup.add(this.handBracketGroup);
  }

  private computeBracketCenterX(startFret: number): number {
    const leftWireX = fretWireToWorldX(startFret - 1, this.config);
    const rightWireX = fretWireToWorldX(startFret + 3, this.config);
    return (leftWireX + rightWireX) / 2;
  }

  /**
   * Builds a stagnant dark slate Highway starting from the top edge of the Target Fretboard at Z = 0
   * and sloping upward into -Z (never flashing colors and never passing behind the fretboard strings).
   */
  private buildPerspectiveHighwayRamp(): void {
    const maxDist = this.config.highwayLengthDist;
    const nutX = fretWireToWorldX(0, this.config);
    const maxWireX = fretWireToWorldX(this.config.maxFret, this.config);
    const highwayWidth = maxWireX - nutX;
    const highwayCenterX = (nutX + maxWireX) / 2;

    const nearY = this.getHighwayFloorY(0);
    const farY = this.getHighwayFloorY(-maxDist);
    const dy = farY - nearY;
    const rampLen = Math.hypot(maxDist, dy);
    const slopeAngle = Math.atan2(dy, maxDist);

    // Stagnant dark slate highway floor bed
    const floorGeo = new THREE.PlaneGeometry(highwayWidth, rampLen);
    floorGeo.rotateX(-Math.PI / 2 + slopeAngle);
    const floorMat = new THREE.MeshBasicMaterial({
      color: 0x090e1a,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
    });
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.position.set(
      highwayCenterX,
      (nearY + farY) / 2 - 0.02,
      -maxDist / 2,
    );
    this.highwayRampGroup.add(floorMesh);

    // Stagnant fret lane guide lines extending from Z=0 into -Z along the highway slope
    for (let f = 0; f <= this.config.maxFret; f++) {
      const x = fretWireToWorldX(f, this.config);
      const isHighlight = this.isStandardFretLabel(f) || f === 0;
      const points = [
        new THREE.Vector3(x, nearY, 0),
        new THREE.Vector3(x, farY, -maxDist),
      ];
      const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
      const lineMat = new THREE.LineBasicMaterial({
        color: isHighlight ? 0x334155 : 0x1e293b,
        transparent: true,
        opacity: isHighlight ? 0.6 : 0.32,
      });
      this.highwayRampGroup.add(new THREE.Line(lineGeo, lineMat));
    }

    // Highway floor fret number markers (3, 5, 7, 9, 12, 15, 17, 19, 21, 24, etc.) along -Z
    const highwayMarkers = [3, 5, 7, 9, 12, 15, 17, 19, 21, 24, 27, 30];
    if (!highwayMarkers.includes(this.config.maxFret)) {
      highwayMarkers.push(this.config.maxFret);
    }
    for (const zMarker of [-5.5, -14.5]) {
      const markerY = this.getHighwayFloorY(zMarker) + 0.1;
      for (const f of highwayMarkers) {
        if (f > this.config.maxFret) continue;
        const markerSprite = this.createFretNumberSprite(String(f), 'standard');
        markerSprite.position.set(
          fretToWorldX(f, this.config),
          markerY,
          zMarker,
        );
        this.highwayRampGroup.add(markerSprite);
      }
    }
  }

  /**
   * Loads a parsed ChartData object, dynamically adjusting fretboard length (maxFret)
   * and building measure/beat bars, 3D note capsules, and chord clusters.
   */
  public loadChart(chart: ChartData): void {
    this.clearChartObjects();
    const nextConfig = computeDynamicFretboardConfig(
      chart.notes,
      this.baseConfig,
    );
    if (
      nextConfig.maxFret !== this.config.maxFret ||
      nextConfig.fretSpacingX !== this.config.fretSpacingX
    ) {
      this.config = nextConfig;
      this.rebuildFretboardAndHighway();
    }
    this.chartNotes = chart.notes;
    this.chartMeasures = chart.measures;
    this.scoring.loadNotes(chart.notes);
    this.particles.clear();
    const initialBpm =
      chart.measures[0]?.bpm || chart.metadata?.initialBpm || 120;
    this.currentBpm = initialBpm > 0 ? initialBpm : 120;
    this.speed = this.baseSpeedAt120Bpm * (this.currentBpm / 120);
    this.buildMeasureAndBeatLines(chart.measures);
    this.buildNoteObjects(chart.notes);
    this.buildChordClusterObjects(chart.notes);
    this.update(this.currentAudioTimeMs);
  }

  private clearChartObjects(): void {
    while (this.notesGroup.children.length > 0) {
      this.notesGroup.remove(this.notesGroup.children[0]);
    }
    while (this.fretboardNotesGroup.children.length > 0) {
      this.fretboardNotesGroup.remove(this.fretboardNotesGroup.children[0]);
    }
    while (this.chordsGroup.children.length > 0) {
      this.chordsGroup.remove(this.chordsGroup.children[0]);
    }
    while (this.measuresGroup.children.length > 0) {
      this.measuresGroup.remove(this.measuresGroup.children[0]);
    }
    this.noteObjects = [];
    this.chordObjects = [];
    this.beatLineObjects = [];
  }

  private buildMeasureAndBeatLines(measures: ChartMeasure[]): void {
    const leftX = fretWireToWorldX(0, this.config);
    const rightX = fretWireToWorldX(this.config.maxFret, this.config);
    const totalWidth = rightX - leftX;
    const centerX = (leftX + rightX) / 2;

    const measureBarGeo = new THREE.BoxGeometry(totalWidth, 0.016, 0.04);
    const measureBarMat = new THREE.MeshBasicMaterial({
      color: 0x475569,
      transparent: true,
      opacity: 0.45,
    });

    const beatBarGeo = new THREE.BoxGeometry(totalWidth, 0.01, 0.02);
    const beatBarMat = new THREE.MeshBasicMaterial({
      color: 0x1e293b,
      transparent: true,
      opacity: 0.3,
    });

    // 8-beat count-in bar lines leading up to the first note
    const firstNoteMs = this.chartNotes[0]?.timeMs ?? 0;
    const countInBpm = measures[0]?.bpm > 0 ? measures[0].bpm : this.currentBpm;
    const countInBeatMs = 60000 / (countInBpm > 0 ? countInBpm : 120);
    for (let b = 8; b >= 1; b--) {
      const beatTimeMs = firstNoteMs - b * countInBeatMs;
      if (beatTimeMs >= (measures[0]?.startMs ?? 0) - 10) continue;
      const isDownbeat = b === 8 || b === 4;
      const cGroup = new THREE.Group();
      const cMesh = new THREE.Mesh(
        isDownbeat ? measureBarGeo : beatBarGeo,
        isDownbeat ? measureBarMat : beatBarMat,
      );
      cMesh.position.set(centerX, 0, 0);
      cGroup.add(cMesh);
      this.measuresGroup.add(cGroup);
      this.beatLineObjects.push({
        timeMs: beatTimeMs,
        isMeasureStart: isDownbeat,
        group: cGroup,
      });
    }

    for (const measure of measures) {
      const mGroup = new THREE.Group();
      const mMesh = new THREE.Mesh(measureBarGeo, measureBarMat);
      mMesh.position.set(centerX, 0, 0);
      mGroup.add(mMesh);

      this.measuresGroup.add(mGroup);
      this.beatLineObjects.push({
        timeMs: measure.startMs,
        isMeasureStart: true,
        measureNumber: measure.number,
        group: mGroup,
      });

      const [numStr] = (measure.timeSignature || '4/4').split('/');
      const beatsPerMeasure = Math.max(1, parseInt(numStr, 10) || 4);
      const beatDurationMs = measure.durationMs / beatsPerMeasure;

      for (let b = 1; b < beatsPerMeasure; b++) {
        const beatTimeMs = measure.startMs + b * beatDurationMs;
        const bGroup = new THREE.Group();
        const bMesh = new THREE.Mesh(beatBarGeo, beatBarMat);
        bMesh.position.set(centerX, 0, 0);
        bGroup.add(bMesh);

        this.measuresGroup.add(bGroup);
        this.beatLineObjects.push({
          timeMs: beatTimeMs,
          isMeasureStart: false,
          group: bGroup,
        });
      }
    }
  }

  /**
   * Builds:
   * 1. Highway Note Capsules (traveling down the -Z highway ramp above the fretboard)
   * 2. Pinned Fretboard Target Capsules (sitting directly on their colored string rail at Z=0
   *    when the note is in the active lookahead/hit window, matching Yousician's UI).
   */
  private buildNoteObjects(notes: ChartNote[]): void {
    const fretWidthScale = Math.min(
      1,
      MIN_DYNAMIC_FRET_COUNT / this.config.maxFret,
    );
    const capsuleGeo = new THREE.CapsuleGeometry(0.082, 0.24, 8, 16);
    capsuleGeo.rotateZ(Math.PI / 2);
    capsuleGeo.scale(fretWidthScale, 0.85, 0.65);

    const slopeAngle = Math.atan(HIGHWAY_SLOPE_Y);
    const tailGeo = new THREE.BoxGeometry(0.12 * fretWidthScale, 0.032, 1.0);
    tailGeo.translate(0, 0, -0.5);
    tailGeo.rotateX(slopeAngle);

    notes.forEach((note, index) => {
      const railSpec = getStringRailSpec(note.string);
      const baseX = fretToWorldX(note.fret, this.config);
      const fretboardY = stringToWorldY(note.string, this.config);
      // Height above the highway floor corresponding to the string (String 6 highest, String 1 lowest)
      const highwayLaneOffset = 0.14 + (note.string - 1) * 0.08;

      // A. Highway 3D note group (for z < 0 along the highway)
      const highwayGroup = new THREE.Group();
      const hwGemMat = new THREE.MeshStandardMaterial({
        color: railSpec.colorHex,
        emissive: railSpec.colorHex,
        emissiveIntensity: 0.6,
        roughness: 0.22,
        metalness: 0.25,
      });
      const hwGemMesh = new THREE.Mesh(capsuleGeo, hwGemMat);
      highwayGroup.add(hwGemMesh);

      const tailMat = new THREE.MeshBasicMaterial({
        color: railSpec.colorHex,
        transparent: true,
        opacity: 0.38,
      });
      const tailMesh = new THREE.Mesh(tailGeo, tailMat);
      highwayGroup.add(tailMesh);

      const stemPoints = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, -highwayLaneOffset, 0),
      ];
      const stemGeo = new THREE.BufferGeometry().setFromPoints(stemPoints);
      const stemMat = new THREE.LineBasicMaterial({
        color: railSpec.colorHex,
        transparent: true,
        opacity: 0.55,
      });
      const stemLine = new THREE.Line(stemGeo, stemMat);
      highwayGroup.add(stemLine);

      const badgeTexture = this.getOrCreateFretBadgeTexture(
        note.fret,
        railSpec.colorCss,
        note.technique,
      );
      const hwSpriteMat = new THREE.SpriteMaterial({
        map: badgeTexture,
        transparent: true,
        depthTest: false,
      });
      const hwBadge = new THREE.Sprite(hwSpriteMat);
      hwBadge.position.set(0, 0, 0.02);
      hwBadge.scale.set(0.38 * fretWidthScale, 0.24, 1);
      hwBadge.renderOrder = 10;
      highwayGroup.add(hwBadge);

      this.notesGroup.add(highwayGroup);

      // B. Target Fretboard capsule (pinned directly on its colored string at Z = 0)
      const fretboardNoteGroup = new THREE.Group();
      fretboardNoteGroup.position.set(baseX, fretboardY, 0.04);

      const fbGemMaterial = new THREE.MeshStandardMaterial({
        color: railSpec.colorHex,
        emissive: railSpec.colorHex,
        emissiveIntensity: 0.75,
        roughness: 0.2,
        metalness: 0.3,
      });
      const fbGemMesh = new THREE.Mesh(capsuleGeo, fbGemMaterial);
      fretboardNoteGroup.add(fbGemMesh);

      const fbSpriteMat = new THREE.SpriteMaterial({
        map: badgeTexture,
        transparent: true,
        depthTest: false,
      });
      const fbBadge = new THREE.Sprite(fbSpriteMat);
      fbBadge.position.set(0, 0, 0.03);
      fbBadge.scale.set(0.4 * fretWidthScale, 0.25, 1);
      fbBadge.renderOrder = 15;
      fretboardNoteGroup.add(fbBadge);

      fretboardNoteGroup.visible = false;
      this.fretboardNotesGroup.add(fretboardNoteGroup);

      this.noteObjects.push({
        note,
        index,
        baseX,
        fretboardY,
        highwayLaneOffset,
        originalColorHex: railSpec.colorHex,
        isDesaturatedMissed: false,
        highwayGroup,
        hwGemMat,
        tailMesh,
        tailMat,
        stemLine,
        stemMat,
        hwSpriteMat,
        fretboardNoteGroup,
        fbGemMesh,
        fbGemMaterial,
      });
    });
  }

  /**
   * Groups simultaneous chord notes (e.g., Dm, A5, E5, G5, C5, B5) inside a transparent
   * wireframe bounding box with a 3D chord label overhead.
   */
  private buildChordClusterObjects(notes: ChartNote[]): void {
    const clusters = extractChordClusters(notes);

    for (const cluster of clusters) {
      const minX = fretToWorldX(cluster.minFret, this.config);
      const maxX = fretToWorldX(cluster.maxFret, this.config);

      const width = Math.max(
        this.config.fretSpacingX * 2.2,
        maxX - minX + this.config.fretSpacingX * 1.1,
      );
      const height = 0.62;
      const depth = 0.24;

      const baseX = (minX + maxX) / 2;

      const group = new THREE.Group();
      group.position.set(baseX, 0, 0);

      const boxGeo = new THREE.BoxGeometry(width, height, depth);
      const boxMat = new THREE.MeshBasicMaterial({
        color: 0xe2e8f0,
        transparent: true,
        opacity: 0.07,
        depthWrite: false,
      });
      const boxMesh = new THREE.Mesh(boxGeo, boxMat);
      group.add(boxMesh);

      const edgesGeo = new THREE.EdgesGeometry(boxGeo);
      const lineMat = new THREE.LineBasicMaterial({
        color: 0xf8fafc,
        transparent: true,
        opacity: 0.8,
      });
      const wireframe = new THREE.LineSegments(edgesGeo, lineMat);
      group.add(wireframe);

      const labelSprite = this.createChordLabelSprite(cluster.chordName);
      labelSprite.position.set(-width / 2 + 0.25, height / 2 + 0.2, 0);
      group.add(labelSprite);

      this.chordsGroup.add(group);
      this.chordObjects.push({
        cluster,
        baseX,
        group,
        wireframe,
        boxMat,
      });
    }
  }

  private getOrCreateFretBadgeTexture(
    fret: number,
    borderColorCss: string,
    technique: string,
  ): THREE.CanvasTexture {
    const cacheKey = `${fret}_${borderColorCss}_${technique}`;
    const existing = this.badgeTextureCache.get(cacheKey);
    if (existing) {
      return existing;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 104;
    const ctx = canvas.getContext('2d')!;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(10, 15, 30, 0.9)';
    ctx.strokeStyle = borderColorCss;
    ctx.lineWidth = 8;

    ctx.beginPath();
    ctx.roundRect(8, 8, canvas.width - 16, canvas.height - 16, 22);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = '900 54px "Inter", -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const centerY =
      technique !== 'normal' ? canvas.height / 2 - 7 : canvas.height / 2 + 2;
    ctx.fillText(String(fret), canvas.width / 2, centerY);

    if (technique && technique !== 'normal') {
      const shortTag =
        technique === 'slide'
          ? 'SL'
          : technique === 'bend'
            ? 'BEND'
            : technique === 'hammer_on'
              ? 'HO'
              : technique === 'pull_off'
                ? 'PO'
                : technique.toUpperCase();
      ctx.fillStyle = borderColorCss;
      ctx.font = '800 18px "Inter", sans-serif';
      ctx.fillText(shortTag, canvas.width / 2, canvas.height - 20);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    this.badgeTextureCache.set(cacheKey, texture);
    return texture;
  }

  private createChordLabelSprite(chordName: string): THREE.Sprite {
    let texture = this.chordLabelCache.get(chordName);
    if (!texture) {
      const canvas = document.createElement('canvas');
      canvas.width = 192;
      canvas.height = 80;
      const ctx = canvas.getContext('2d')!;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ffffff';
      ctx.font = '900 48px "Inter", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
      ctx.shadowBlur = 8;
      ctx.fillText(chordName, canvas.width / 2, canvas.height / 2);

      texture = new THREE.CanvasTexture(canvas);
      this.chordLabelCache.set(chordName, texture);
    }

    const mat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.76, 0.32, 1);
    sprite.renderOrder = 14;
    return sprite;
  }

  private getOrCreateFretNumberTexture(
    text: string,
    mode: 'standard' | 'active' | 'dim',
  ): THREE.CanvasTexture {
    const key = `${text}_${mode}`;
    const cached = this.fretLabelTextureCache.get(key);
    if (cached) return cached;

    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle =
      mode === 'active'
        ? '#ffeb3b'
        : mode === 'standard'
          ? '#cbd5e1'
          : '#475569';
    ctx.font = `${mode === 'active' ? '900' : '700'} 38px "Inter", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    this.fretLabelTextureCache.set(key, texture);
    return texture;
  }

  private createFretNumberSprite(
    text: string,
    mode: 'standard' | 'active' | 'dim',
  ): THREE.Sprite {
    const fretWidthScale = Math.min(
      1,
      MIN_DYNAMIC_FRET_COUNT / this.config.maxFret,
    );
    const texture = this.getOrCreateFretNumberTexture(text, mode);
    const mat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.38 * fretWidthScale, 0.25, 1);
    return sprite;
  }

  private desaturateNoteAsMissed(obj: NoteRenderObject): void {
    if (obj.isDesaturatedMissed) return;
    obj.isDesaturatedMissed = true;

    obj.hwGemMat.color.setHex(0x334155);
    obj.hwGemMat.emissive.setHex(0x0f172a);
    obj.hwGemMat.emissiveIntensity = 0.08;
    obj.hwGemMat.transparent = true;
    obj.hwGemMat.opacity = 0.35;
    obj.hwGemMat.needsUpdate = true;

    obj.tailMat.color.setHex(0x334155);
    obj.tailMat.opacity = 0.18;

    obj.stemMat.color.setHex(0x334155);
    obj.stemMat.opacity = 0.18;

    obj.hwSpriteMat.opacity = 0.35;
    obj.fretboardNoteGroup.visible = false;
  }

  private restoreNoteMaterials(obj: NoteRenderObject): void {
    if (!obj.isDesaturatedMissed) return;
    obj.isDesaturatedMissed = false;

    obj.hwGemMat.color.setHex(obj.originalColorHex);
    obj.hwGemMat.emissive.setHex(obj.originalColorHex);
    obj.hwGemMat.emissiveIntensity = 0.6;
    obj.hwGemMat.transparent = false;
    obj.hwGemMat.opacity = 1.0;
    obj.hwGemMat.needsUpdate = true;

    obj.tailMat.color.setHex(obj.originalColorHex);
    obj.tailMat.opacity = 0.38;

    obj.stemMat.color.setHex(obj.originalColorHex);
    obj.stemMat.opacity = 0.55;

    obj.hwSpriteMat.opacity = 1.0;
  }

  /**
   * Flashes the target fretboard string rail (1–6) with an emissive pulse.
   */
  public flashStringRail(stringNumber: number): void {
    const clamped = Math.max(1, Math.min(6, Math.round(stringNumber)));
    this.stringRailPulses.set(clamped, 1.0);
    const mat = this.stringRailMaterials.get(clamped);
    if (mat) {
      mat.emissiveIntensity = 2.6;
    }
    const mesh = this.stringRailMeshes.get(clamped);
    if (mesh) {
      mesh.scale.set(1.45, 1, 1.45);
    }
  }

  /**
   * Triggers a hit check on `stringIndex` (1–6) and optional `fret` at `currentAudioTimeMs`.
   * If a note is hit within the timing window (<= 120ms):
   * - Immediately removes the note capsule from the highway
   * - Spawns a 3D particle burst at (X, Y, Z=0) in the string's color
   * - Spawns a 3D floating rating popup ("PERFECT", "GREAT", "GOOD")
   * - Flashes the target string rail with an emissive pulse
   */
  public triggerHit(
    stringIndex: number,
    fret?: number | null,
    currentAudioTimeMs: number = this.currentAudioTimeMs,
  ): HitEvaluationResult {
    const targetString =
      stringIndex >= 1 && stringIndex <= 6
        ? Math.round(stringIndex)
        : Math.max(1, Math.min(6, Math.round(stringIndex) + 1));

    this.flashStringRail(targetString);

    const result = this.scoring.checkHit(
      targetString,
      fret,
      currentAudioTimeMs,
    );
    if (result.hit && result.noteIndex >= 0 && result.rating) {
      this.triggerNoteDestruction(result);
    }
    return result;
  }

  /**
   * Evaluates a live guitar pitch detector MIDI note against any unjudged note within the hit window.
   */
  public triggerPitchHit(
    detectedMidiNote: number,
    currentAudioTimeMs: number = this.currentAudioTimeMs,
  ): HitEvaluationResult {
    const result = this.scoring.checkPitchHit(
      detectedMidiNote,
      currentAudioTimeMs,
    );
    if (result.hit && result.noteIndex >= 0 && result.rating) {
      this.flashStringRail(result.note!.string);
      this.triggerNoteDestruction(result);
    }
    return result;
  }

  private triggerNoteDestruction(result: HitEvaluationResult): void {
    const obj = this.noteObjects[result.noteIndex];
    if (!obj || !result.rating) return;

    // Immediately remove note capsule from highway and fretboard
    obj.highwayGroup.visible = false;
    obj.fretboardNoteGroup.visible = false;

    // Spawn 20–30 glowing sparks at contact coordinates (X, Y, Z = 0)
    this.particles.spawnBurst(
      obj.baseX,
      obj.fretboardY,
      0,
      obj.originalColorHex,
      26,
    );

    // Spawn floating 3D rating sprite ("PERFECT", "GREAT", "GOOD")
    this.particles.spawnFloatingRating(
      obj.baseX,
      obj.fretboardY,
      0,
      result.rating,
    );

    this.callbacks.onNoteHit?.(result);
  }

  public resetScoring(): void {
    this.scoring.reset();
    this.particles.clear();
    for (const obj of this.noteObjects) {
      this.restoreNoteMaterials(obj);
    }
  }

  public syncScoringToSeek(seekTimeMs: number): void {
    this.scoring.syncToSeekTime(seekTimeMs);
    this.particles.clear();
    for (const obj of this.noteObjects) {
      this.restoreNoteMaterials(obj);
    }
  }

  public getScoreState(): ScoreState {
    return this.scoring.getState();
  }

  /**
   * Updates all measure bars, 3D highway notes, target fretboard notes, chord wireframe boxes,
   * particle bursts, string rail pulses, and the active 4-fret hand position bracket for `currentAudioTimeMs`.
   */
  public update(currentAudioTimeMs: number): void {
    this.currentAudioTimeMs = currentAudioTimeMs;

    // 0. Sync highway scroll speed to the active measure's BPM
    if (this.chartMeasures.length > 0) {
      const lookupMs = Math.max(0, currentAudioTimeMs);
      let activeMeasure = this.chartMeasures[0];
      for (let i = this.chartMeasures.length - 1; i >= 0; i--) {
        if (lookupMs >= this.chartMeasures[i].startMs) {
          activeMeasure = this.chartMeasures[i];
          break;
        }
      }
      const targetBpm = activeMeasure.bpm > 0 ? activeMeasure.bpm : 120;
      this.currentBpm += (targetBpm - this.currentBpm) * 0.15;
      this.speed = this.baseSpeedAt120Bpm * (this.currentBpm / 120);
    }

    // 0b. Decay target string rail emissive pulses
    for (const [sNum, pulse] of this.stringRailPulses.entries()) {
      if (pulse <= 0.001) continue;
      const nextPulse = pulse * 0.84;
      this.stringRailPulses.set(sNum, nextPulse < 0.01 ? 0 : nextPulse);
      const mat = this.stringRailMaterials.get(sNum);
      if (mat) {
        mat.emissiveIntensity = 0.55 + nextPulse * 2.05;
      }
      const mesh = this.stringRailMeshes.get(sNum);
      if (mesh) {
        const sc = 1 + nextPulse * 0.45;
        mesh.scale.set(sc, 1, sc);
      }
    }

    // 1. Update Active 4-Fret Hand Position Bracket
    this.activeHandFrets = computeActiveHandPosition(
      this.chartNotes,
      currentAudioTimeMs,
      this.config.maxFret,
    );
    this.handBracketTargetX = this.computeBracketCenterX(
      this.activeHandFrets.startFret,
    );
    this.handBracketCurrentX +=
      (this.handBracketTargetX - this.handBracketCurrentX) * 0.2;
    this.handBracketGroup.position.x = this.handBracketCurrentX;

    const handKey = `${this.activeHandFrets.startFret}-${this.activeHandFrets.endFret}`;
    if (handKey !== this.lastHighlightedHandKey) {
      this.lastHighlightedHandKey = handKey;
      for (const [f, sprite] of this.fretLabelSprites.entries()) {
        const inBracket =
          f >= this.activeHandFrets.startFret &&
          f <= this.activeHandFrets.endFret;
        const isStandard = this.isStandardFretLabel(f);
        sprite.visible = inBracket || isStandard;
        const mat = sprite.material as THREE.SpriteMaterial;
        mat.map = this.getOrCreateFretNumberTexture(
          String(f),
          inBracket ? 'active' : 'standard',
        );
      }
    }

    // 2. Update Measure & Beat Bars along the sloped -Z highway
    for (const item of this.beatLineObjects) {
      const z = projectTimeToZ(item.timeMs, currentAudioTimeMs, this.speed);
      const visible = z <= 0 && z >= -this.config.highwayLengthDist;
      item.group.visible = visible;
      if (visible) {
        item.group.position.y = this.getHighwayFloorY(z);
        item.group.position.z = z;
      }
    }

    // 3. Update Chord Cluster 3D Wireframe Bounding Boxes along the sloped -Z highway
    for (const cObj of this.chordObjects) {
      const z = projectTimeToZ(
        cObj.cluster.timeMs,
        currentAudioTimeMs,
        this.speed,
      );
      const visible = z <= 0 && z >= -this.config.highwayLengthDist;
      cObj.group.visible = visible;
      if (visible) {
        const floorY = this.getHighwayFloorY(z);
        cObj.group.position.set(cObj.baseX, floorY + 0.34, z);
      }
    }

    // 4. Update Highway Note Capsules, Target Fretboard Capsules, and Hit/Miss Resolution
    const activeNotes: ChartNote[] = [];
    const goodWindowMs = this.scoring.getTimingWindows().goodMs;

    for (const obj of this.noteObjects) {
      let noteState = this.scoring.getNoteState(obj.index);

      // HIT notes are immediately removed from the highway and fretboard
      if (noteState === 'HIT') {
        obj.highwayGroup.visible = false;
        obj.fretboardNoteGroup.visible = false;
        continue;
      }

      const timeDeltaMs = obj.note.timeMs - currentAudioTimeMs;
      // signedRelZ = (note.timeMs - currentAudioTimeMs) * (speed / 1000)
      // > 0 when approaching target bar, 0 at target bar, < 0 after passing target bar
      const signedRelZ = timeDeltaMs * (this.speed / 1000);
      const worldZ = projectTimeToZ(
        obj.note.timeMs,
        currentAudioTimeMs,
        this.speed,
      );
      const tailLen = Math.max(
        0.06,
        durationToWorldZ(obj.note.durationMs, this.speed) * 0.78,
      );

      // MISS resolution: if note passes Z < -0.8 beyond the target bar AND is past the 120ms GOOD window
      if (
        noteState === 'PENDING' &&
        signedRelZ < -0.8 &&
        -timeDeltaMs > goodWindowMs
      ) {
        const missEvent = this.scoring.markNoteMissed(obj.index);
        noteState = 'MISSED';
        this.desaturateNoteAsMissed(obj);
        if (missEvent) {
          this.callbacks.onNoteMiss?.(missEvent);
        }
      }

      if (noteState === 'MISSED') {
        // Missed notes do NOT explode or delete instantly:
        // Desaturated to dull semi-transparent gray/black (opacity: 0.35), they continue
        // traveling straight through the strings into the foreground before despawning at Z < -3.0.
        this.desaturateNoteAsMissed(obj);
        obj.fretboardNoteGroup.visible = false;

        if (signedRelZ >= -3.0) {
          obj.highwayGroup.visible = true;
          const fallThroughY =
            worldZ <= 0
              ? this.getHighwayFloorY(worldZ) + obj.highwayLaneOffset
              : obj.fretboardY;
          obj.highwayGroup.position.set(obj.baseX, fallThroughY, worldZ);
          obj.tailMesh.scale.set(1, 1, tailLen);
        } else {
          obj.highwayGroup.visible = false;
        }
        continue;
      }

      // PENDING note: visible on the highway while approaching Z = 0, and continues smoothly
      // through the strings from Z = 0 to Z = -0.8 if unhit before transitioning to MISSED.
      const hwVisible =
        signedRelZ <= this.config.highwayLengthDist && signedRelZ >= -0.8;
      obj.highwayGroup.visible = hwVisible;
      if (hwVisible) {
        const noteY =
          worldZ <= 0
            ? this.getHighwayFloorY(worldZ) + obj.highwayLaneOffset
            : obj.fretboardY;
        obj.highwayGroup.position.set(obj.baseX, noteY, worldZ);
        obj.tailMesh.scale.set(1, 1, tailLen);
      }

      // Target Fretboard capsule appears on its exact horizontal string at Z = 0
      // when the note is arriving within 900ms and inside the hit window.
      const isHitActive = isNoteActiveAtHitBar(
        obj.note.timeMs,
        obj.note.durationMs,
        currentAudioTimeMs,
        goodWindowMs,
      );
      const isUpcomingOnFretboard =
        timeDeltaMs >= -goodWindowMs && timeDeltaMs <= 900;

      obj.fretboardNoteGroup.visible = isUpcomingOnFretboard;
      if (isUpcomingOnFretboard) {
        if (isHitActive) {
          activeNotes.push(obj.note);
          obj.fbGemMaterial.emissiveIntensity = 1.85;
          obj.fbGemMesh.scale.set(1.22, 1.05, 0.85);
        } else {
          obj.fbGemMaterial.emissiveIntensity = 0.7;
          obj.fbGemMesh.scale.set(1, 0.85, 0.65);
        }
      }
    }

    this.activeNotesAtHitBar = activeNotes;

    // 5. Update 3D burst particles and floating rating sprites
    this.particles.update(currentAudioTimeMs);

    this.renderer.render(this.scene, this.camera);
  }

  public setSpeedMultiplier(speedOrMultiplier: number): void {
    this.baseSpeedAt120Bpm = Math.max(
      4,
      Math.min(50, normalizeSpeedUnitsPerSec(speedOrMultiplier)),
    );
    this.speed = this.baseSpeedAt120Bpm * (this.currentBpm / 120);
    this.update(this.currentAudioTimeMs);
  }

  public getSpeedMultiplier(): number {
    return this.speed / 1000;
  }

  public getSpeed(): number {
    return this.speed;
  }

  public getCurrentBpm(): number {
    return this.currentBpm;
  }

  public getActiveNotesAtHitBar(): ChartNote[] {
    return this.activeNotesAtHitBar;
  }

  public getActiveHandPosition(): { startFret: number; endFret: number } {
    return this.activeHandFrets;
  }

  public getMaxFret(): number {
    return this.config.maxFret;
  }

  public onWindowResize(): void {
    const width = Math.max(1, this.container.clientWidth || window.innerWidth);
    const height = Math.max(
      1,
      this.container.clientHeight || window.innerHeight,
    );
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.renderer.render(this.scene, this.camera);
  }

  public dispose(): void {
    window.removeEventListener('resize', this.handleResizeBound);
    this.renderer.dispose();
  }
}
