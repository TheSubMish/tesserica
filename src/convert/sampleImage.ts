/**
 * The built-in sample photo: a sunset landscape, drawn procedurally.
 *
 * Nothing is bundled or downloaded, so there is no asset to license
 * (`bundled-asset-license`). It is deliberately a *good test card* for a
 * pixel-art converter — a smooth sky gradient (shows banding and dither), hard
 * silhouettes (shows edge handling), a sun and a reflection (shows highlights),
 * and a warm/cool split (shows how a palette handles hue).
 */
export const SAMPLE_WIDTH = 640;
export const SAMPLE_HEIGHT = 480;

export function drawSampleImage(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const horizon = h * 0.62;

  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, '#1d2b6b');
  sky.addColorStop(0.45, '#8a4f9e');
  sky.addColorStop(0.75, '#f2788a');
  sky.addColorStop(1, '#ffc178');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, horizon);

  // Sun and glow.
  const sx = w * 0.68;
  const glow = ctx.createRadialGradient(sx, horizon, 4, sx, horizon, w * 0.42);
  glow.addColorStop(0, 'rgba(255,236,170,0.95)');
  glow.addColorStop(0.25, 'rgba(255,190,120,0.45)');
  glow.addColorStop(1, 'rgba(255,150,120,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, horizon);
  ctx.fillStyle = '#fff3c4';
  ctx.beginPath();
  ctx.arc(sx, horizon - 6, h * 0.075, 0, Math.PI * 2);
  ctx.fill();

  // Water with a sun reflection.
  const water = ctx.createLinearGradient(0, horizon, 0, h);
  water.addColorStop(0, '#f09a7a');
  water.addColorStop(0.35, '#7a4a8f');
  water.addColorStop(1, '#14204f');
  ctx.fillStyle = water;
  ctx.fillRect(0, horizon, w, h - horizon);
  for (let i = 0; i < 14; i++) {
    const y = horizon + 6 + i * ((h - horizon - 10) / 14);
    const half = (h * 0.075 * (1 + i * 0.22)) / 2;
    ctx.fillStyle = `rgba(255,232,170,${0.7 - i * 0.045})`;
    ctx.fillRect(sx - half, y, half * 2, 3);
  }

  // Far hills, near hills (hard silhouettes).
  ctx.fillStyle = '#4a2f6e';
  hills(ctx, w, horizon, h * 0.1, 0.011, 1.3);
  ctx.fillStyle = '#231a4a';
  hills(ctx, w, horizon + 4, h * 0.075, 0.017, 4.1);

  // Pine trees on the left bank.
  ctx.fillStyle = '#0f0f2a';
  for (let i = 0; i < 7; i++) {
    const tx = 18 + i * 30 + (i % 2) * 8;
    const th = h * (0.2 + 0.05 * ((i * 5) % 4));
    pine(ctx, tx, horizon + 8, th);
  }

  // Stars.
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  for (let i = 0; i < 40; i++) {
    const x = (i * 97) % w;
    const y = ((i * 53) % Math.floor(horizon * 0.5)) + 4;
    ctx.fillRect(x, y, 2, 2);
  }
}

function hills(
  ctx: CanvasRenderingContext2D,
  w: number,
  base: number,
  amp: number,
  freq: number,
  phase: number,
): void {
  ctx.beginPath();
  ctx.moveTo(0, base);
  for (let x = 0; x <= w; x += 4) {
    ctx.lineTo(
      x,
      base - amp * (0.55 + 0.45 * Math.sin(x * freq + phase) * Math.cos(x * freq * 0.37)),
    );
  }
  ctx.lineTo(w, base + 2);
  ctx.lineTo(0, base + 2);
  ctx.closePath();
  ctx.fill();
}

function pine(ctx: CanvasRenderingContext2D, x: number, base: number, height: number): void {
  ctx.beginPath();
  for (let tier = 0; tier < 4; tier++) {
    const top = base - height + tier * (height / 5);
    const width = height * (0.16 + tier * 0.07);
    ctx.moveTo(x, top);
    ctx.lineTo(x + width, top + height / 3);
    ctx.lineTo(x - width, top + height / 3);
    ctx.closePath();
  }
  ctx.fill();
  ctx.fillRect(x - 2, base - height / 6, 4, height / 6);
}

/** The sample as encoded PNG bytes, ready for `stageBytes`. */
export async function renderSampleImagePng(): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_WIDTH;
  canvas.height = SAMPLE_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas is unavailable, cannot draw the sample image');
  drawSampleImage(ctx, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('could not encode the sample image');
  return new Uint8Array(await blob.arrayBuffer());
}
