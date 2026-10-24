import * as THREE from 'three';
import type { HitRating } from './scoring';

const MAX_PARTICLES = 768;
const MAX_FLOATING_POPUPS = 18;

interface ParticleSlot {
  active: boolean;
  ageMs: number;
  lifetimeMs: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  baseR: number;
  baseG: number;
  baseB: number;
}

interface FloatingPopupSlot {
  active: boolean;
  ageMs: number;
  lifetimeMs: number;
  startX: number;
  startY: number;
  startZ: number;
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
}

/**
 * Lightweight, zero-allocation Three.js Particle Destruction & 3D Floating Rating System.
 *
 * Uses a pre-allocated ring buffer of `THREE.Points` vertices (`BufferGeometry`) and
 * pooled `THREE.Sprite` popups so note explosions never trigger garbage collection hiccups.
 */
export class ParticleSystem {
  public readonly group = new THREE.Group();

  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly positionAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;
  private readonly pointsMesh: THREE.Points;
  private readonly slots: ParticleSlot[] = [];
  private cursor = 0;

  private readonly popupSlots: FloatingPopupSlot[] = [];
  private popupCursor = 0;
  private readonly ratingTextureCache: Map<HitRating, THREE.CanvasTexture> =
    new Map();

  private lastAudioTimeMs: number | null = null;

  constructor() {
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.colors = new Float32Array(MAX_PARTICLES * 3);

    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.positions[i * 3] = 0;
      this.positions[i * 3 + 1] = -999;
      this.positions[i * 3 + 2] = 0;
      this.slots.push({
        active: false,
        ageMs: 0,
        lifetimeMs: 380,
        x: 0,
        y: -999,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        baseR: 1,
        baseG: 1,
        baseB: 1,
      });
    }

    const geometry = new THREE.BufferGeometry();
    this.positionAttr = new THREE.BufferAttribute(this.positions, 3);
    this.positionAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.BufferAttribute(this.colors, 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);

    geometry.setAttribute('position', this.positionAttr);
    geometry.setAttribute('color', this.colorAttr);

    const sparkTexture = this.createSparkTexture();
    const material = new THREE.PointsMaterial({
      size: 0.24,
      map: sparkTexture,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });

    this.pointsMesh = new THREE.Points(geometry, material);
    this.pointsMesh.frustumCulled = false;
    this.pointsMesh.renderOrder = 20;
    this.group.add(this.pointsMesh);

    // Pre-allocate pooled 3D floating rating sprites
    for (let i = 0; i < MAX_FLOATING_POPUPS; i++) {
      const mat = new THREE.SpriteMaterial({
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.renderOrder = 25;
      this.group.add(sprite);
      this.popupSlots.push({
        active: false,
        ageMs: 0,
        lifetimeMs: 420,
        startX: 0,
        startY: 0,
        startZ: 0,
        sprite,
        material: mat,
      });
    }
  }

  /**
   * Spawns 20–30 glowing sparks at `(x, y, z)` matching `colorHex` that burst outward
   * with random velocities, gravity, and brightness decay over 300–450 ms.
   */
  public spawnBurst(
    x: number,
    y: number,
    z: number,
    colorHex: number,
    count = 26,
  ): void {
    const baseColor = new THREE.Color(colorHex);
    const sparkCount = Math.max(20, Math.min(30, count));

    for (let i = 0; i < sparkCount; i++) {
      const idx = this.cursor;
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;

      const slot = this.slots[idx];
      slot.active = true;
      slot.ageMs = 0;
      slot.lifetimeMs = 300 + Math.random() * 150; // 300–450 ms

      slot.x = x + (Math.random() - 0.5) * 0.14;
      slot.y = y + (Math.random() - 0.5) * 0.08;
      slot.z = z + (Math.random() - 0.5) * 0.08;

      const theta = Math.random() * Math.PI * 2;
      const elevation = (Math.random() - 0.25) * Math.PI * 0.85;
      const speed = 1.6 + Math.random() * 3.4;

      slot.vx = Math.cos(theta) * Math.cos(elevation) * speed;
      slot.vy = Math.abs(Math.sin(elevation)) * speed * 1.15 + 0.9;
      slot.vz = Math.sin(theta) * Math.cos(elevation) * speed * 0.85;

      // Mix string color with hot white core on 30% of sparks
      const whiteMix = i % 3 === 0 ? 0.45 : 0.12;
      slot.baseR = baseColor.r + (1 - baseColor.r) * whiteMix;
      slot.baseG = baseColor.g + (1 - baseColor.g) * whiteMix;
      slot.baseB = baseColor.b + (1 - baseColor.b) * whiteMix;

      const i3 = idx * 3;
      this.positions[i3] = slot.x;
      this.positions[i3 + 1] = slot.y;
      this.positions[i3 + 2] = slot.z;

      this.colors[i3] = slot.baseR;
      this.colors[i3 + 1] = slot.baseG;
      this.colors[i3 + 2] = slot.baseB;
    }

    this.positionAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
  }

  /**
   * Spawns a floating 3D rating sprite ("PERFECT", "GREAT", "GOOD") above the hit note
   * that scales up and fades out over 420 ms.
   */
  public spawnFloatingRating(
    x: number,
    y: number,
    z: number,
    rating: HitRating,
  ): void {
    const slot = this.popupSlots[this.popupCursor];
    this.popupCursor = (this.popupCursor + 1) % MAX_FLOATING_POPUPS;

    slot.active = true;
    slot.ageMs = 0;
    slot.lifetimeMs = 430;
    slot.startX = x;
    slot.startY = y + 0.24;
    slot.startZ = z + 0.08;

    slot.material.map = this.getOrCreateRatingTexture(rating);
    slot.material.opacity = 1;
    slot.material.needsUpdate = true;

    slot.sprite.position.set(slot.startX, slot.startY, slot.startZ);
    slot.sprite.scale.set(0.65, 0.24, 1);
    slot.sprite.visible = true;
  }

  /**
   * Advances active particles and floating rating sprites.
   * Uses `currentAudioTimeMs` delta when audio is advancing, with a 16.6ms frame fallback
   * so test hotkeys (`1`–`6`) also animate smoothly while playback is paused.
   */
  public update(currentAudioTimeMs: number): void {
    let dtMs = 16.67;
    if (this.lastAudioTimeMs !== null) {
      const audioDelta = currentAudioTimeMs - this.lastAudioTimeMs;
      if (audioDelta > 0.5 && audioDelta < 100) {
        dtMs = audioDelta;
      }
    }
    this.lastAudioTimeMs = currentAudioTimeMs;
    const dtSec = dtMs / 1000;
    const gravity = -6.8;

    let anyParticleUpdated = false;

    for (let i = 0; i < MAX_PARTICLES; i++) {
      const slot = this.slots[i];
      if (!slot.active) continue;

      slot.ageMs += dtMs;
      const i3 = i * 3;

      if (slot.ageMs >= slot.lifetimeMs) {
        slot.active = false;
        this.positions[i3 + 1] = -999;
        this.colors[i3] = 0;
        this.colors[i3 + 1] = 0;
        this.colors[i3 + 2] = 0;
        anyParticleUpdated = true;
        continue;
      }

      slot.vy += gravity * dtSec;
      slot.vx *= 0.96;
      slot.vz *= 0.96;

      slot.x += slot.vx * dtSec;
      slot.y += slot.vy * dtSec;
      slot.z += slot.vz * dtSec;

      const lifeProgress = slot.ageMs / slot.lifetimeMs;
      // Smooth quadratic fade-out
      const intensity = Math.max(0, 1 - lifeProgress * lifeProgress);

      this.positions[i3] = slot.x;
      this.positions[i3 + 1] = slot.y;
      this.positions[i3 + 2] = slot.z;

      this.colors[i3] = slot.baseR * intensity;
      this.colors[i3 + 1] = slot.baseG * intensity;
      this.colors[i3 + 2] = slot.baseB * intensity;
      anyParticleUpdated = true;
    }

    if (anyParticleUpdated) {
      this.positionAttr.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
    }

    // Update 3D floating rating popups
    for (let i = 0; i < MAX_FLOATING_POPUPS; i++) {
      const popup = this.popupSlots[i];
      if (!popup.active) continue;

      popup.ageMs += dtMs;
      if (popup.ageMs >= popup.lifetimeMs) {
        popup.active = false;
        popup.sprite.visible = false;
        continue;
      }

      const t = popup.ageMs / popup.lifetimeMs;
      const popScale = t < 0.22 ? 0.65 + (t / 0.22) * 0.45 : 1.1 - (t - 0.22) * 0.25;
      popup.sprite.position.set(
        popup.startX,
        popup.startY + t * 0.52,
        popup.startZ,
      );
      popup.sprite.scale.set(0.82 * popScale, 0.3 * popScale, 1);
      popup.material.opacity = t < 0.55 ? 1 : Math.max(0, 1 - (t - 0.55) / 0.45);
    }
  }

  public clear(): void {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.slots[i].active = false;
      this.positions[i * 3 + 1] = -999;
      this.colors[i * 3] = 0;
      this.colors[i * 3 + 1] = 0;
      this.colors[i * 3 + 2] = 0;
    }
    this.positionAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;

    for (const popup of this.popupSlots) {
      popup.active = false;
      popup.sprite.visible = false;
    }
  }

  private createSparkTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;

    const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(0.35, 'rgba(255, 255, 255, 0.85)');
    grad.addColorStop(0.7, 'rgba(255, 255, 255, 0.25)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  private getOrCreateRatingTexture(rating: HitRating): THREE.CanvasTexture {
    const cached = this.ratingTextureCache.get(rating);
    if (cached) return cached;

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 96;
    const ctx = canvas.getContext('2d')!;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const colorMap: Record<HitRating, { fill: string; glow: string }> = {
      PERFECT: { fill: '#4ade80', glow: '#22c55e' },
      GREAT: { fill: '#38bdf8', glow: '#0ea5e9' },
      GOOD: { fill: '#facc15', glow: '#eab308' },
      MISS: { fill: '#f87171', glow: '#ef4444' },
    };

    const palette = colorMap[rating];
    ctx.font = '900 46px "Big Shoulders Display", "Inter", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.shadowColor = palette.glow;
    ctx.shadowBlur = 16;
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(6, 9, 17, 0.92)';
    ctx.strokeText(rating, canvas.width / 2, canvas.height / 2);

    ctx.fillStyle = palette.fill;
    ctx.fillText(rating, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    this.ratingTextureCache.set(rating, texture);
    return texture;
  }
}
