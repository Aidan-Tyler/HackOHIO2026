import * as THREE from 'three';
import type { ChartData, ChartMeasure, ChartNote } from '../types/chart';
import {
  DEFAULT_HIGHWAY_CONFIG,
  STRING_RAILS,
  computeActiveHandPosition,
  durationToWorldZ,
  extractChordClusters,
  fretToWorldX,
  fretWireToWorldX,
  getStringRailSpec,
  highwayDistToWorldYZ,
  isNoteActiveAtHitBar,
  isZVisible,
  projectTimeToZ,
  stringToWorldX,
  stringToWorldY,
  type ChordCluster,
  type HighwayConfig,
} from './coordinates';

export {
  DEFAULT_HIGHWAY_CONFIG,
  STRING_RAILS,
  computeActiveHandPosition,
  durationToWorldZ,
  extractChordClusters,
  fretToWorldX,
  fretWireToWorldX,
  getStringRailSpec,
  highwayDistToWorldYZ,
  isNoteActiveAtHitBar,
  isZVisible,
  projectTimeToZ,
  stringToWorldX,
  stringToWorldY,
  type ChordCluster,
  type HighwayConfig,
};

interface NoteRenderObject {
  note: ChartNote;
  index: number;
  baseX: number;
  baseY: number;
  group: THREE.Group;
  gemMesh: THREE.Mesh;
  gemMaterial: THREE.MeshStandardMaterial;
  tailMesh: THREE.Mesh;
  tailMaterial: THREE.MeshBasicMaterial;
  badgeSprite: THREE.Sprite;
}

interface ChordClusterRenderObject {
  cluster: ChordCluster;
  baseX: number;
  baseY: number;
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

export class HighwayEngine {
  private readonly container: HTMLElement;
  private readonly config: HighwayConfig;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;

  private readonly fretboardGroup = new THREE.Group();
  private readonly highwayRampGroup = new THREE.Group();
  private readonly measuresGroup = new THREE.Group();
  private readonly notesGroup = new THREE.Group();
  private readonly chordsGroup = new THREE.Group();

  private readonly fretboardStringMats: Map<number, THREE.MeshStandardMaterial> =
    new Map();
  private readonly highwayStringMats: Map<number, THREE.MeshBasicMaterial> =
    new Map();

  // Active 4-fret hand position bracket on the pinned fretboard
  private handBracketGroup = new THREE.Group();
  private handBracketCurrentX = 0;
  private handBracketTargetX = 0;
  private activeHandFrets: { startFret: number; endFret: number } = {
    startFret: 1,
    endFret: 4,
  };

  private chartNotes: ChartNote[] = [];
  private noteObjects: NoteRenderObject[] = [];
  private chordObjects: ChordClusterRenderObject[] = [];
  private beatLineObjects: BeatLineRenderObject[] = [];
  private badgeTextureCache: Map<string, THREE.CanvasTexture> = new Map();
  private chordLabelCache: Map<string, THREE.CanvasTexture> = new Map();

  private currentTimeMs = 0;
  private speedMultiplier: number;
  private activeNotesAtHitBar: ChartNote[] = [];

  private readonly handleResizeBound: () => void;

  constructor(
    container: HTMLElement,
    config: Partial<HighwayConfig> = {},
  ) {
    this.container = container;
    this.config = { ...DEFAULT_HIGHWAY_CONFIG, ...config };
    this.speedMultiplier = this.config.speedMultiplier;

    // 1. Scene Setup
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x060913);
    this.scene.fog = new THREE.FogExp2(0x060913, 0.016);

    // 2. Camera looking at the pinned horizontal fretboard at bottom and ~30° highway behind it
    const width = Math.max(1, container.clientWidth || window.innerWidth);
    const height = Math.max(1, container.clientHeight || window.innerHeight);
    this.camera = new THREE.PerspectiveCamera(48, width / height, 0.1, 140);
    this.camera.position.set(-0.6, 2.35, 13.2);
    this.camera.lookAt(-0.6, 1.05, 0);

    // 3. WebGLRenderer
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.container.appendChild(this.renderer.domElement);

    // 4. Build Scene Lighting, Pinned Fretboard Target Bar, and 30° Perspective Highway
    this.setupLights();
    this.buildPinnedFretboardTargetBar();
    this.buildPerspectiveHighwayRamp();

    this.scene.add(this.highwayRampGroup);
    this.scene.add(this.measuresGroup);
    this.scene.add(this.chordsGroup);
    this.scene.add(this.notesGroup);
    this.scene.add(this.fretboardGroup);

    // 5. Window Resize Listener
    this.handleResizeBound = () => this.onWindowResize();
    window.addEventListener('resize', this.handleResizeBound);
  }

  private setupLights(): void {
    const ambientLight = new THREE.AmbientLight(0xe2e8f0, 0.9);
    this.scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.35);
    keyLight.position.set(2, 12, 14);
    this.scene.add(keyLight);

    const fretboardGlow = new THREE.PointLight(0x38bdf8, 1.8, 22, 1.4);
    fretboardGlow.position.set(0, 0.5, 3.0);
    this.scene.add(fretboardGlow);
  }

  /**
   * Builds the Pinned Fretboard Target Bar at Z=0:
   * - 6 horizontal colored strings (String 6/Low E at top down to String 1/High E at bottom)
   * - Vertical metallic fret wires across frets 0 through 24 with numbered labels underneath
   * - Glowing green active 4-fret hand position bracket
   */
  private buildPinnedFretboardTargetBar(): void {
    const totalFretWidth = this.config.maxFret * this.config.fretSpacingX;
    const nutPadLeft = this.config.fretSpacingX * 0.9;
    const boardWidth = totalFretWidth + nutPadLeft + 0.4;
    const boardCenterX = -nutPadLeft / 2;
    const boardHeight = this.config.stringSpacingY * 5 + 0.52;

    // Rosewood / Ebony fretboard backing slab at Z=0
    const boardGeo = new THREE.BoxGeometry(boardWidth, boardHeight, 0.16);
    const boardMat = new THREE.MeshStandardMaterial({
      color: 0x111827,
      roughness: 0.65,
      metalness: 0.25,
    });
    const boardMesh = new THREE.Mesh(boardGeo, boardMat);
    boardMesh.position.set(boardCenterX, 0, -0.09);
    this.fretboardGroup.add(boardMesh);

    // Top & bottom metallic fretboard bevel trim
    const trimGeo = new THREE.BoxGeometry(boardWidth, 0.05, 0.2);
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      emissive: 0x0ea5e9,
      emissiveIntensity: 0.35,
      roughness: 0.3,
      metalness: 0.8,
    });
    for (const sign of [-1, 1]) {
      const trim = new THREE.Mesh(trimGeo, trimMat);
      trim.position.set(boardCenterX, sign * (boardHeight / 2 + 0.02), -0.06);
      this.fretboardGroup.add(trim);
    }

    // Vertical metallic fret wires across Frets 0 (Nut) through 24 + numbered labels underneath
    const nutWireGeo = new THREE.CylinderGeometry(0.042, 0.042, boardHeight, 12);
    const nutWireMat = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      emissive: 0xe2e8f0,
      emissiveIntensity: 0.4,
      roughness: 0.2,
      metalness: 0.85,
    });

    const fretWireGeo = new THREE.CylinderGeometry(
      0.022,
      0.022,
      boardHeight - 0.04,
      10,
    );
    const fretWireMat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      roughness: 0.22,
      metalness: 0.9,
    });

    const inlaySingleFrets = new Set([3, 5, 7, 9, 15, 17, 19, 21]);
    const inlayDoubleFrets = new Set([12, 24]);
    const inlayGeo = new THREE.CircleGeometry(0.075, 16);
    const inlayMat = new THREE.MeshBasicMaterial({
      color: 0x475569,
      transparent: true,
      opacity: 0.55,
    });

    // Fret 0 label underneath the nut slot
    const zeroLabel = this.createFretNumberSprite('0', true);
    zeroLabel.position.set(
      fretToWorldX(0, this.config),
      -boardHeight / 2 - 0.28,
      0.05,
    );
    this.fretboardGroup.add(zeroLabel);

    for (let f = 0; f <= this.config.maxFret; f++) {
      const wireX = fretWireToWorldX(f, this.config);
      const wireMesh = new THREE.Mesh(
        f === 0 ? nutWireGeo : fretWireGeo,
        f === 0 ? nutWireMat : fretWireMat,
      );
      wireMesh.position.set(wireX, 0, 0);
      this.fretboardGroup.add(wireMesh);

      if (f >= 1) {
        const slotCenterX = fretToWorldX(f, this.config);
        const isMarker =
          inlaySingleFrets.has(f) || inlayDoubleFrets.has(f);

        // Numbered fret label (1..24) underneath the fretboard
        const fretLabel = this.createFretNumberSprite(String(f), isMarker);
        fretLabel.position.set(slotCenterX, -boardHeight / 2 - 0.28, 0.05);
        this.fretboardGroup.add(fretLabel);

        // Classic fretboard inlay dots
        if (inlaySingleFrets.has(f)) {
          const dot = new THREE.Mesh(inlayGeo, inlayMat);
          dot.position.set(slotCenterX, 0, -0.005);
          this.fretboardGroup.add(dot);
        } else if (inlayDoubleFrets.has(f)) {
          for (const offsetY of [-0.55, 0.55]) {
            const dot = new THREE.Mesh(inlayGeo, inlayMat);
            dot.position.set(slotCenterX, offsetY, -0.005);
            this.fretboardGroup.add(dot);
          }
        }
      }
    }

    // 6 Horizontal Colored Strings (String 6 / Low E at top down to String 1 / High E at bottom)
    for (const railSpec of STRING_RAILS) {
      const y = stringToWorldY(
        railSpec.stringNumber,
        this.config.stringSpacingY,
      );
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
        metalness: 0.7,
      });
      const strMesh = new THREE.Mesh(strGeo, strMat);
      strMesh.position.set(boardCenterX, y, 0.025);
      this.fretboardGroup.add(strMesh);
      this.fretboardStringMats.set(railSpec.stringNumber, strMat);

      // String name badge on the left edge of the fretboard
      const badge = this.createLaneLabelSprite(
        railSpec.label,
        railSpec.colorCss,
      );
      badge.position.set(
        fretWireToWorldX(0, this.config) - this.config.fretSpacingX * 1.35,
        y,
        0.06,
      );
      this.fretboardGroup.add(badge);
    }

    // Active 4-Fret Hand Position Bracket (glowing green highlight)
    const bracketWidth = this.config.fretSpacingX * 4;
    const bracketHeight = boardHeight + 0.16;

    const bracketFillGeo = new THREE.PlaneGeometry(
      bracketWidth,
      bracketHeight,
    );
    const bracketFillMat = new THREE.MeshBasicMaterial({
      color: 0x22c55e,
      transparent: true,
      opacity: 0.14,
      side: THREE.DoubleSide,
    });
    const bracketFill = new THREE.Mesh(bracketFillGeo, bracketFillMat);
    this.handBracketGroup.add(bracketFill);

    const bracketBoxGeo = new THREE.BoxGeometry(
      bracketWidth,
      bracketHeight,
      0.18,
    );
    const bracketEdges = new THREE.EdgesGeometry(bracketBoxGeo);
    const bracketLineMat = new THREE.LineBasicMaterial({
      color: 0x4ade80,
      transparent: true,
      opacity: 0.95,
    });
    const bracketWire = new THREE.LineSegments(bracketEdges, bracketLineMat);
    this.handBracketGroup.add(bracketWire);

    // Top glowing header bar on the active hand position bracket
    const topBarGeo = new THREE.BoxGeometry(bracketWidth, 0.07, 0.22);
    const topBarMat = new THREE.MeshBasicMaterial({
      color: 0x22c55e,
    });
    const topBar = new THREE.Mesh(topBarGeo, topBarMat);
    topBar.position.set(0, bracketHeight / 2, 0.04);
    this.handBracketGroup.add(topBar);

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
   * Builds the Perspective Highway extending back into the scene from Z=0 at a ~30° elevation angle.
   */
  private buildPerspectiveHighwayRamp(): void {
    const maxDist = this.config.highwayLengthDist;
    const farYZ = highwayDistToWorldYZ(
      maxDist,
      this.config.highwayElevationDeg,
    );

    // Fret lane guide lines extending from each fret wire at Z=0 back along the 30° highway slope
    for (let f = 0; f <= this.config.maxFret; f++) {
      const x = fretWireToWorldX(f, this.config);
      const isHighlight = f === 0 || f % 5 === 0 || f === 12 || f === 24;
      const points = [
        new THREE.Vector3(x, 0, 0),
        new THREE.Vector3(x, farYZ.yOffset, farYZ.z),
      ];
      const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
      const lineMat = new THREE.LineBasicMaterial({
        color: isHighlight ? 0x38bdf8 : 0x1e293b,
        transparent: true,
        opacity: isHighlight ? 0.32 : 0.16,
      });
      this.highwayRampGroup.add(new THREE.Line(lineGeo, lineMat));
    }

    // 6 colored string guide rails extending back into the scene at 30° from each string's Y position
    for (const railSpec of STRING_RAILS) {
      const baseY = stringToWorldY(
        railSpec.stringNumber,
        this.config.stringSpacingY,
      );
      const leftX = fretToWorldX(0, this.config);
      const rightX = fretWireToWorldX(this.config.maxFret, this.config);

      // Subtle translucent horizontal ribbon along the string plane
      const ribbonWidth = rightX - leftX;
      const ribbonCenterX = (leftX + rightX) / 2;
      const ribbonGeo = new THREE.PlaneGeometry(ribbonWidth, maxDist);
      const rad = (this.config.highwayElevationDeg * Math.PI) / 180;
      ribbonGeo.rotateX(-Math.PI / 2 + rad);

      const ribbonMat = new THREE.MeshBasicMaterial({
        color: railSpec.colorHex,
        transparent: true,
        opacity: 0.045,
        side: THREE.DoubleSide,
      });
      const ribbonMesh = new THREE.Mesh(ribbonGeo, ribbonMat);
      ribbonMesh.position.set(
        ribbonCenterX,
        baseY + farYZ.yOffset / 2,
        farYZ.z / 2,
      );
      this.highwayRampGroup.add(ribbonMesh);
      this.highwayStringMats.set(railSpec.stringNumber, ribbonMat);
    }
  }

  /**
   * Loads a parsed ChartData object, building measure/beat bars, 3D note capsules, and chord clusters.
   */
  public loadChart(chart: ChartData): void {
    this.clearChartObjects();
    this.chartNotes = chart.notes;
    this.buildMeasureAndBeatLines(chart.measures);
    this.buildNoteObjects(chart.notes);
    this.buildChordClusterObjects(chart.notes);
    this.update(this.currentTimeMs);
  }

  private clearChartObjects(): void {
    while (this.notesGroup.children.length > 0) {
      this.notesGroup.remove(this.notesGroup.children[0]);
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
    const leftX = fretToWorldX(0, this.config) - 0.2;
    const rightX = fretWireToWorldX(this.config.maxFret, this.config) + 0.2;
    const totalWidth = rightX - leftX;
    const centerX = (leftX + rightX) / 2;

    const measureBarGeo = new THREE.BoxGeometry(totalWidth, 0.03, 0.06);
    const measureBarMat = new THREE.MeshBasicMaterial({
      color: 0x64748b,
      transparent: true,
      opacity: 0.45,
    });

    const beatBarGeo = new THREE.BoxGeometry(totalWidth - 0.4, 0.015, 0.03);
    const beatBarMat = new THREE.MeshBasicMaterial({
      color: 0x334155,
      transparent: true,
      opacity: 0.22,
    });

    for (const measure of measures) {
      const mGroup = new THREE.Group();
      const mMesh = new THREE.Mesh(measureBarGeo, measureBarMat);
      mMesh.position.set(centerX, 0, 0);
      mGroup.add(mMesh);

      const numSprite = this.createMeasureLabelSprite(`M${measure.number}`);
      numSprite.position.set(leftX - 0.65, 0, 0);
      mGroup.add(numSprite);

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

  private buildNoteObjects(notes: ChartNote[]): void {
    // Rounded rectangular capsule geometry oriented horizontally inside its fret slot
    const capsuleGeo = new THREE.CapsuleGeometry(0.135, 0.28, 10, 16);
    capsuleGeo.rotateZ(Math.PI / 2);

    // Sustain tail extending back along the ~30° highway slope
    const rad = (this.config.highwayElevationDeg * Math.PI) / 180;
    const tailGeo = new THREE.BoxGeometry(0.18, 0.045, 1.0);
    tailGeo.translate(0, 0, -0.5);
    tailGeo.rotateX(rad);

    notes.forEach((note, index) => {
      const railSpec = getStringRailSpec(note.string);
      const baseX = fretToWorldX(note.fret, this.config);
      const baseY = stringToWorldY(note.string, this.config.stringSpacingY);

      const group = new THREE.Group();
      group.position.set(baseX, baseY, 0);

      const gemMaterial = new THREE.MeshStandardMaterial({
        color: railSpec.colorHex,
        emissive: railSpec.colorHex,
        emissiveIntensity: 0.55,
        roughness: 0.22,
        metalness: 0.3,
      });
      const gemMesh = new THREE.Mesh(capsuleGeo, gemMaterial);
      group.add(gemMesh);

      const tailMaterial = new THREE.MeshBasicMaterial({
        color: railSpec.colorHex,
        transparent: true,
        opacity: 0.4,
      });
      const tailMesh = new THREE.Mesh(tailGeo, tailMaterial);
      const tailLen = Math.max(
        0.08,
        durationToWorldZ(note.durationMs, this.speedMultiplier) * 0.78,
      );
      tailMesh.scale.set(1, 1, tailLen);
      group.add(tailMesh);

      // Fret number badge (0–24) centered on the rounded capsule
      const badgeTexture = this.getOrCreateFretBadgeTexture(
        note.fret,
        railSpec.colorCss,
        note.technique,
      );
      const spriteMat = new THREE.SpriteMaterial({
        map: badgeTexture,
        transparent: true,
        depthTest: false,
      });
      const badgeSprite = new THREE.Sprite(spriteMat);
      badgeSprite.position.set(0, 0, 0.16);
      badgeSprite.scale.set(0.58, 0.38, 1);
      badgeSprite.renderOrder = 12;
      group.add(badgeSprite);

      this.notesGroup.add(group);
      this.noteObjects.push({
        note,
        index,
        baseX,
        baseY,
        group,
        gemMesh,
        gemMaterial,
        tailMesh,
        tailMaterial,
        badgeSprite,
      });
    });
  }

  /**
   * Builds transparent 3D wireframe bounding boxes with overhead chord name labels
   * for simultaneous chord clusters (e.g. E5, G5, C5, B5, A5, Dm, C).
   */
  private buildChordClusterObjects(notes: ChartNote[]): void {
    const clusters = extractChordClusters(notes);

    for (const cluster of clusters) {
      const minX = fretToWorldX(cluster.minFret, this.config);
      const maxX = fretToWorldX(cluster.maxFret, this.config);
      const yA = stringToWorldY(cluster.minString, this.config.stringSpacingY);
      const yB = stringToWorldY(cluster.maxString, this.config.stringSpacingY);
      const minY = Math.min(yA, yB);
      const maxY = Math.max(yA, yB);

      const width = Math.max(this.config.fretSpacingX * 1.15, maxX - minX + 0.72);
      const height = Math.max(0.55, maxY - minY + 0.48);
      const depth = 0.36;

      const baseX = (minX + maxX) / 2;
      const baseY = (minY + maxY) / 2;

      const group = new THREE.Group();
      group.position.set(baseX, baseY, 0);

      // Translucent 3D bounding box fill
      const boxGeo = new THREE.BoxGeometry(width, height, depth);
      const boxMat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.08,
        depthWrite: false,
      });
      const boxMesh = new THREE.Mesh(boxGeo, boxMat);
      group.add(boxMesh);

      // 3D Wireframe edges
      const edgesGeo = new THREE.EdgesGeometry(boxGeo);
      const lineMat = new THREE.LineBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.78,
      });
      const wireframe = new THREE.LineSegments(edgesGeo, lineMat);
      group.add(wireframe);

      // Overhead chord name label (e.g. "E5", "G5", "C5", "Dm")
      const labelSprite = this.createChordLabelSprite(cluster.chordName);
      labelSprite.position.set(0, height / 2 + 0.28, 0);
      group.add(labelSprite);

      this.chordsGroup.add(group);
      this.chordObjects.push({
        cluster,
        baseX,
        baseY,
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
    ctx.fillStyle = 'rgba(10, 15, 30, 0.92)';
    ctx.strokeStyle = borderColorCss;
    ctx.lineWidth = 7;

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

      ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.roundRect(8, 8, canvas.width - 16, canvas.height - 16, 14);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#38bdf8';
      ctx.font = '900 38px "Inter", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(chordName, canvas.width / 2, canvas.height / 2 + 1);

      texture = new THREE.CanvasTexture(canvas);
      this.chordLabelCache.set(chordName, texture);
    }

    const mat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.82, 0.34, 1);
    sprite.renderOrder = 14;
    return sprite;
  }

  private createFretNumberSprite(
    text: string,
    isHighlighted: boolean,
  ): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;

    ctx.fillStyle = isHighlighted ? '#f8fafc' : '#64748b';
    ctx.font = `${isHighlighted ? '800' : '600'} 34px "Inter", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.42, 0.28, 1);
    return sprite;
  }

  private createLaneLabelSprite(
    text: string,
    colorCss: string,
  ): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 76;
    const ctx = canvas.getContext('2d')!;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
    ctx.strokeStyle = colorCss;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(6, 8, canvas.width - 12, canvas.height - 16, 14);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#f8fafc';
    ctx.font = '800 28px "Inter", -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.95, 0.3, 1);
    return sprite;
  }

  private createMeasureLabelSprite(text: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 140;
    canvas.height = 68;
    const ctx = canvas.getContext('2d')!;

    ctx.fillStyle = 'rgba(30, 41, 59, 0.85)';
    ctx.beginPath();
    ctx.roundRect(6, 8, canvas.width - 12, canvas.height - 16, 10);
    ctx.fill();

    ctx.fillStyle = '#94a3b8';
    ctx.font = '700 28px "Inter", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.7, 0.34, 1);
    return sprite;
  }

  /**
   * Updates all measure bars, 3D note capsules, chord wireframe boxes, and the active 4-fret
   * hand position bracket for `currentTimeMs`.
   */
  public update(currentTimeMs: number): void {
    this.currentTimeMs = currentTimeMs;

    // 1. Update Active 4-Fret Hand Position Bracket
    this.activeHandFrets = computeActiveHandPosition(
      this.chartNotes,
      currentTimeMs,
      this.config.maxFret,
    );
    this.handBracketTargetX = this.computeBracketCenterX(
      this.activeHandFrets.startFret,
    );
    this.handBracketCurrentX +=
      (this.handBracketTargetX - this.handBracketCurrentX) * 0.18;
    this.handBracketGroup.position.x = this.handBracketCurrentX;

    // 2. Update Measure & Beat Bars along the 30° highway slope
    for (const item of this.beatLineObjects) {
      const dist = projectTimeToZ(
        item.timeMs,
        currentTimeMs,
        this.speedMultiplier,
      );
      const visible = isZVisible(dist, this.config);
      item.group.visible = visible;
      if (visible) {
        const yz = highwayDistToWorldYZ(dist, this.config.highwayElevationDeg);
        item.group.position.y = yz.yOffset;
        item.group.position.z = yz.z;
      }
    }

    // 3. Update Chord Cluster 3D Wireframe Bounding Boxes
    for (const cObj of this.chordObjects) {
      const dist = projectTimeToZ(
        cObj.cluster.timeMs,
        currentTimeMs,
        this.speedMultiplier,
      );
      const visible = isZVisible(dist, this.config);
      cObj.group.visible = visible;
      if (visible) {
        const yz = highwayDistToWorldYZ(dist, this.config.highwayElevationDeg);
        cObj.group.position.set(cObj.baseX, cObj.baseY + yz.yOffset, yz.z);
        const active = isNoteActiveAtHitBar(
          cObj.cluster.timeMs,
          cObj.cluster.durationMs,
          currentTimeMs,
          this.config.hitWindowMs,
        );
        cObj.boxMat.opacity = active ? 0.22 : 0.08;
      }
    }

    // 4. Update 3D Note Capsules along their String Rail and Fret Column
    const activeStrings = new Set<number>();
    const activeNotes: ChartNote[] = [];

    for (const obj of this.noteObjects) {
      const dist = projectTimeToZ(
        obj.note.timeMs,
        currentTimeMs,
        this.speedMultiplier,
      );
      const tailLen = Math.max(
        0.08,
        durationToWorldZ(obj.note.durationMs, this.speedMultiplier) * 0.78,
      );
      const visible =
        dist + tailLen >= this.config.despawnDist &&
        dist <= this.config.highwayLengthDist;

      obj.group.visible = visible;
      if (!visible) {
        continue;
      }

      const yz = highwayDistToWorldYZ(dist, this.config.highwayElevationDeg);
      obj.group.position.set(obj.baseX, obj.baseY + yz.yOffset, yz.z);
      obj.tailMesh.scale.set(1, 1, tailLen);

      const isHitActive = isNoteActiveAtHitBar(
        obj.note.timeMs,
        obj.note.durationMs,
        currentTimeMs,
        this.config.hitWindowMs,
      );

      if (isHitActive) {
        activeStrings.add(obj.note.string);
        activeNotes.push(obj.note);
        obj.gemMaterial.emissiveIntensity = 1.85;
        obj.gemMesh.scale.setScalar(1.24);
      } else {
        obj.gemMaterial.emissiveIntensity = 0.55;
        obj.gemMesh.scale.setScalar(1.0);
      }
    }

    this.activeNotesAtHitBar = activeNotes;

    // 5. Highlight active horizontal strings on the pinned fretboard & highway
    for (const railSpec of STRING_RAILS) {
      const isStrActive = activeStrings.has(railSpec.stringNumber);
      const fbMat = this.fretboardStringMats.get(railSpec.stringNumber);
      const hwMat = this.highwayStringMats.get(railSpec.stringNumber);
      if (fbMat) {
        fbMat.emissiveIntensity = isStrActive ? 1.8 : 0.55;
      }
      if (hwMat) {
        hwMat.opacity = isStrActive ? 0.16 : 0.045;
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  public setSpeedMultiplier(speedMultiplier: number): void {
    this.speedMultiplier = Math.max(0.004, Math.min(0.05, speedMultiplier));
    this.update(this.currentTimeMs);
  }

  public getSpeedMultiplier(): number {
    return this.speedMultiplier;
  }

  public getActiveNotesAtHitBar(): ChartNote[] {
    return this.activeNotesAtHitBar;
  }

  public getActiveHandPosition(): { startFret: number; endFret: number } {
    return this.activeHandFrets;
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
