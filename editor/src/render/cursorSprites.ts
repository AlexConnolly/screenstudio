// Vector cursor sprites (§4.3): crisp at any size/zoom, matching Windows cursor types.
// Drawn at origin = hotspot; callers translate/scale first.

type Ctx = CanvasRenderingContext2D;

function outlinedPath(ctx: Ctx, draw: () => void) {
  ctx.save();
  ctx.lineJoin = "round";
  draw();
  ctx.restore();
}

function drawArrow(ctx: Ctx) {
  // Classic Windows arrow, hotspot at tip (0,0), ~24px tall at scale 1.
  outlinedPath(ctx, () => {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 21);
    ctx.lineTo(4.8, 16.6);
    ctx.lineTo(8.2, 24);
    ctx.lineTo(11.4, 22.5);
    ctx.lineTo(8.1, 15.2);
    ctx.lineTo(14.6, 15.2);
    ctx.closePath();
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.lineWidth = 1.6;
    ctx.fill();
    ctx.stroke();
  });
}

function drawIBeam(ctx: Ctx) {
  outlinedPath(ctx, () => {
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    beam(ctx);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2.4;
    beam(ctx);
  });
  function beam(c: Ctx) {
    c.beginPath();
    c.moveTo(-4, -10); c.lineTo(4, -10);
    c.moveTo(0, -10); c.lineTo(0, 10);
    c.moveTo(-4, 10); c.lineTo(4, 10);
    c.stroke();
  }
}

function drawHand(ctx: Ctx) {
  // Simplified pointing hand, hotspot at fingertip.
  outlinedPath(ctx, () => {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(-2.5, 6, -2.5, 10);
    ctx.lineTo(-6, 8);
    ctx.quadraticCurveTo(-9, 7, -8, 11);
    ctx.lineTo(-2.5, 19);
    ctx.quadraticCurveTo(-1, 22, 3, 22);
    ctx.lineTo(8, 22);
    ctx.quadraticCurveTo(12, 21, 12, 16);
    ctx.lineTo(12, 8);
    ctx.quadraticCurveTo(12, 5, 9, 5);
    ctx.lineTo(9, 4);
    ctx.quadraticCurveTo(9, 1, 6, 1);
    ctx.lineTo(5.4, 1);
    ctx.quadraticCurveTo(4.6, -1.5, 2.4, -1);
    ctx.quadraticCurveTo(0.6, -0.8, 0, 0);
    ctx.closePath();
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.lineWidth = 1.6;
    ctx.fill();
    ctx.stroke();
  });
}

function drawResize(ctx: Ctx, angle: number) {
  ctx.save();
  ctx.rotate(angle);
  outlinedPath(ctx, () => {
    ctx.beginPath();
    // double-headed arrow centered on hotspot
    ctx.moveTo(-11, 0); ctx.lineTo(-5, -5); ctx.lineTo(-5, -1.8);
    ctx.lineTo(5, -1.8); ctx.lineTo(5, -5); ctx.lineTo(11, 0);
    ctx.lineTo(5, 5); ctx.lineTo(5, 1.8);
    ctx.lineTo(-5, 1.8); ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.lineWidth = 1.4;
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();
}

export function drawCursorSprite(ctx: Ctx, type: string, x: number, y: number, scale: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  switch (type) {
    case "ibeam": drawIBeam(ctx); break;
    case "hand": drawHand(ctx); break;
    case "we": drawResize(ctx, 0); break;
    case "ns": drawResize(ctx, Math.PI / 2); break;
    case "nwse": drawResize(ctx, Math.PI / 4); break;
    case "nesw": drawResize(ctx, -Math.PI / 4); break;
    case "all":
      drawResize(ctx, 0);
      drawResize(ctx, Math.PI / 2);
      break;
    default: drawArrow(ctx); break;
  }
  ctx.restore();
}
