import { useEffect, useRef, useState } from "react";
import {
  compactGlassFrame,
  compactGlassGeometryReady,
  compactGlassOpticsAllowed,
  compactGlassShapes,
} from "./compactGlassModel";

const VERTEX_SHADER = `#version 300 es
precision highp float;

const vec2 POSITIONS[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2( 3.0, -1.0),
  vec2(-1.0,  3.0)
);

void main() {
  gl_Position = vec4(POSITIONS[gl_VertexID], 0.0, 1.0);
}
`;

/**
 * This shader intentionally does not sample a desktop texture. AppKit's
 * NSVisualEffectView is the privacy-preserving background sampler underneath
 * the transparent WebView. The shader models only the optical response above
 * that sample: analytical SDF silhouette, height/normal, two interfaces,
 * three refraction zones, dispersion, then shadow.
 */
const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec4 u_shapeA;
uniform vec4 u_shapeB;
uniform float u_radiusA;
uniform float u_radiusB;
uniform int u_shapeCount;
uniform float u_pixelRatio;
uniform float u_dark;
uniform float u_nativeBackdrop;

out vec4 outColor;

float roundedBoxSdf(vec2 point, vec2 halfSize, float radius) {
  vec2 offset = abs(point) - halfSize + radius;
  return min(max(offset.x, offset.y), 0.0) + length(max(offset, 0.0)) - radius;
}

float shapeDistance(vec2 pixel, vec4 shape, float radius) {
  vec2 halfSize = max(vec2(1.0), shape.zw - vec2(1.35 * u_pixelRatio));
  return roundedBoxSdf(pixel - shape.xy, halfSize, radius);
}

float surfaceDistance(vec2 pixel) {
  float first = shapeDistance(pixel, u_shapeA, u_radiusA);
  if (u_shapeCount < 2) return first;
  return min(first, shapeDistance(pixel, u_shapeB, u_radiusB));
}

float surfaceHeight(vec2 pixel) {
  float depth = max(-surfaceDistance(pixel), 0.0);
  float activeRadius = u_shapeCount < 2 ? u_radiusA : min(u_radiusA, u_radiusB);
  float shoulder = max(3.0 * u_pixelRatio, activeRadius * 0.72);
  // A smooth height field grows from zero at the rim toward the lens centre.
  return smoothstep(0.0, shoulder, depth);
}

float frostedNoise(vec2 cell) {
  vec2 seed = fract(cell * vec2(123.34, 456.21));
  seed += dot(seed, seed + 45.32);
  return fract(seed.x * seed.y);
}

void main() {
  vec2 pixel = gl_FragCoord.xy;
  float firstShapeDistance = shapeDistance(pixel, u_shapeA, u_radiusA);
  float secondShapeDistance = u_shapeCount < 2
    ? 1e6
    : shapeDistance(pixel, u_shapeB, u_radiusB);
  bool useSecondShape = secondShapeDistance < firstShapeDistance;
  vec4 activeShape = useSecondShape ? u_shapeB : u_shapeA;
  float activeRadius = useSecondShape ? u_radiusB : u_radiusA;
  vec2 local = pixel - activeShape.xy;
  float distanceToSurface = surfaceDistance(pixel);
  float aa = max(fwidth(distanceToSurface), 0.65);
  float coverage = 1.0 - smoothstep(-aa, aa, distanceToSurface);
  float depth = max(-distanceToSurface, 0.0);

  float stepSize = max(0.8, u_pixelRatio);
  float heightLeft = surfaceHeight(pixel - vec2(stepSize, 0.0));
  float heightRight = surfaceHeight(pixel + vec2(stepSize, 0.0));
  float heightDown = surfaceHeight(pixel - vec2(0.0, stepSize));
  float heightUp = surfaceHeight(pixel + vec2(0.0, stepSize));
  vec3 normal = normalize(vec3(
    -(heightRight - heightLeft) * 6.4,
    -(heightUp - heightDown) * 6.4,
    1.0
  ));

  // Two-interface response: air -> glass at the curved top, then glass -> air
  // at a flatter back face. It drives highlights and dispersion only because
  // the live desktop sample is owned by AppKit and is not exposed to WebGL.
  const float glassIor = 1.48;
  vec3 incident = normalize(vec3(-0.16, -0.24, -1.0));
  vec3 entryRay = refract(incident, normal, 1.0 / glassIor);
  vec3 exitNormal = normalize(vec3(-normal.xy * 0.42, normal.z));
  vec3 exitRay = refract(entryRay, exitNormal, glassIor);
  if (length(exitRay) < 0.01) {
    exitRay = reflect(entryRay, exitNormal);
  }
  vec2 opticalPath = entryRay.xy * 0.58 + exitRay.xy * 0.42;

  // Preserve the same apparent glass thickness when AppKit gives the
  // camera-safe shoulders less height than the detached compact capsule.
  // The zones stay proportional to the capsule radius instead of becoming a
  // visibly heavier, milkier ring on the shorter placement.
  float opticalScale = clamp(
    activeRadius / max(17.75 * u_pixelRatio, 1.0),
    0.55,
    1.25
  );
  float px = u_pixelRatio * opticalScale;
  float outerRegion = coverage * (1.0 - smoothstep(0.0, 1.7 * px, depth));
  float innerRegion = coverage
    * smoothstep(1.1 * px, 3.0 * px, depth)
    * (1.0 - smoothstep(5.0 * px, 8.5 * px, depth));
  float centreRegion = coverage * smoothstep(6.0 * px, 11.0 * px, depth);

  vec2 safeHalf = max(vec2(1.0), activeShape.zw - vec2(1.0));
  vec2 uv = local / safeHalf;
  vec3 lightDirection = normalize(vec3(-0.34, 0.58, 0.74));
  float specular = pow(max(dot(normal, lightDirection), 0.0), 22.0);
  float fresnel = pow(1.0 - clamp(normal.z, 0.0, 1.0), 2.1);
  float opticalSweep = smoothstep(
    -0.18,
    0.34,
    dot(uv + opticalPath * 0.18, normalize(vec2(-0.72, 0.69)))
  );

  // Background/tint first. The native AppKit material already contributes
  // most of the body, so its WebGL centre tint is deliberately quieter.
  vec3 lightBody = vec3(0.91, 0.955, 1.0);
  vec3 darkBody = vec3(0.36, 0.40, 0.49);
  vec3 bodyColor = mix(lightBody, darkBody, u_dark);
  // A fixed, CSS-pixel-aligned micro-grain adds surface roughness without a
  // time uniform or a continuous render loop. AppKit remains the real source
  // of desktop blur; this is only the restrained frosted veil above it.
  vec2 grainCell = floor(pixel / max(1.0, u_pixelRatio * 2.0));
  float grain = frostedNoise(grainCell) - 0.5;
  float grainRegion = clamp(
    centreRegion + innerRegion * 0.6 + outerRegion * 0.25,
    0.0,
    1.0
  );
  float grainStrength = mix(0.018, 0.012, u_dark) * u_nativeBackdrop;
  bodyColor = clamp(bodyColor + vec3(grain * grainStrength * grainRegion), 0.0, 1.0);
  float bodyAlpha = centreRegion * mix(
    mix(0.055, 0.10, u_nativeBackdrop),
    mix(0.105, 0.13, u_nativeBackdrop),
    u_dark
  );
  bodyAlpha += innerRegion * mix(
    mix(0.055, 0.10, u_nativeBackdrop),
    mix(0.075, 0.13, u_nativeBackdrop),
    u_dark
  );
  bodyAlpha += outerRegion * mix(
    mix(0.075, 0.13, u_nativeBackdrop),
    mix(0.095, 0.16, u_nativeBackdrop),
    u_dark
  );

  vec3 premultiplied = bodyColor * bodyAlpha;
  float alpha = bodyAlpha;

  // Highlights second. Three slightly shifted lobes approximate wavelength
  // dispersion without continuously animating an always-visible widget.
  float edgeLight = coverage * (outerRegion * 0.82 + innerRegion * 0.34);
  vec3 dispersion = vec3(
    pow(max(dot(normal, normalize(lightDirection + vec3(-0.055, 0.0, 0.0))), 0.0), 28.0),
    pow(max(dot(normal, lightDirection), 0.0), 28.0),
    pow(max(dot(normal, normalize(lightDirection + vec3(0.055, 0.0, 0.0))), 0.0), 28.0)
  );
  vec3 highlightColor = vec3(1.0) * (specular * 0.15 + opticalSweep * edgeLight * 0.12);
  highlightColor += dispersion * edgeLight * 0.075;
  highlightColor += vec3(0.72, 0.86, 1.0) * fresnel * outerRegion * 0.09;
  float highlightPeak = max(max(highlightColor.r, highlightColor.g), highlightColor.b);
  float highlightAlpha = coverage * min(highlightPeak, 0.24);
  vec3 highlightPremultiplied = highlightPeak > 1e-5
    ? highlightColor * (highlightAlpha / highlightPeak)
    : vec3(0.0);
  premultiplied += highlightPremultiplied * (1.0 - alpha);
  alpha = alpha + highlightAlpha * (1.0 - alpha);

  // Shadow last: a narrow outside contact shadow and a restrained inner
  // bottom edge establish thickness without drawing a plastic dark border.
  float outside = max(distanceToSurface, 0.0);
  float outsideBand = (1.0 - coverage) * (1.0 - smoothstep(0.0, 4.2 * px, outside));
  float bottomBias = smoothstep(-0.12, 0.92, -uv.y);
  float contactShadow = outsideBand * bottomBias * mix(0.085, 0.16, u_dark);
  float innerShadow = outerRegion * bottomBias * mix(0.035, 0.09, u_dark);
  premultiplied *= 1.0 - innerShadow;
  vec3 shadowColor = mix(vec3(0.18, 0.24, 0.34), vec3(0.0), u_dark);
  premultiplied += shadowColor * contactShadow * (1.0 - alpha);
  alpha = alpha + contactShadow * (1.0 - alpha);

  outColor = vec4(premultiplied, clamp(alpha, 0.0, 1.0));
}
`;

type CompactGlassLayout = "single" | "split";

interface CompactSdfGlassProps {
  nativeBackdrop: boolean;
  layout?: CompactGlassLayout;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("无法创建 WebGL shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "未知编译错误";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  let vertex: WebGLShader | undefined;
  let fragment: WebGLShader | undefined;
  let program: WebGLProgram | undefined;
  try {
    vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    program = gl.createProgram() ?? undefined;
    if (!program) throw new Error("无法创建 WebGL program");
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? "未知链接错误");
    }
    return program;
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
  }
}

function mediaQueryMatches(query: string): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

/**
 * Event-driven optical overlay for the compact presentation only.
 *
 * It renders once after mount and again only for resize/appearance changes.
 * There is no requestAnimationFrame loop, pointer tracking, or texture copy in
 * the permanently visible compact state.
 */
export function CompactSdfGlass({
  nativeBackdrop,
  layout = "single",
}: CompactSdfGlassProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mediaRevision, setMediaRevision] = useState(0);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const queries = [
      window.matchMedia("(prefers-color-scheme: dark)"),
      window.matchMedia("(prefers-reduced-transparency: reduce)"),
      window.matchMedia("(prefers-contrast: more)"),
      window.matchMedia("(forced-colors: active)"),
    ];
    const onChange = () => setMediaRevision((value) => value + 1);
    queries.forEach((query) => query.addEventListener("change", onChange));
    return () => {
      queries.forEach((query) => query.removeEventListener("change", onChange));
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const capsule = canvas.parentElement;
    if (!capsule) return;
    const sideSurfaces = layout === "split"
      ? Array.from(capsule.querySelectorAll<HTMLElement>(".widget-capsule-side")).slice(0, 2)
      : [];
    const surfaces = layout === "split"
      ? sideSurfaces
      : [canvas.closest<HTMLElement>(".widget-notch")].filter(
          (surface): surface is HTMLElement => Boolean(surface),
        );
    if (surfaces.length === 0) return;

    const markState = (
      state: "ready" | "fallback",
      reason?:
        | "accessibility"
        | "webgl2"
        | "shader"
        | "uniforms"
        | "geometry"
        | "context-lost",
    ) => {
      canvas.dataset.compactGlassState = state;
      if (reason) canvas.dataset.compactGlassReason = reason;
      else delete canvas.dataset.compactGlassReason;
      surfaces.forEach((surface) => {
        surface.dataset.compactGlassState = state;
        surface.dataset.compactGlassBackdrop = nativeBackdrop ? "appkit" : "webview";
        surface.dataset.compactGlassImplementation = "sdf-webgl2-v1";
      });
    };
    const clearState = () => {
      delete canvas.dataset.compactGlassState;
      delete canvas.dataset.compactGlassReason;
      surfaces.forEach((surface) => {
        delete surface.dataset.compactGlassState;
        delete surface.dataset.compactGlassBackdrop;
        delete surface.dataset.compactGlassImplementation;
      });
    };

    const reducedTransparency = mediaQueryMatches(
      "(prefers-reduced-transparency: reduce)",
    );
    const increasedContrast = mediaQueryMatches("(prefers-contrast: more)");
    const forcedColors = mediaQueryMatches("(forced-colors: active)");
    if (reducedTransparency || increasedContrast || forcedColors) {
      markState("fallback", "accessibility");
      return clearState;
    }
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: "low-power",
    });

    if (
      !compactGlassOpticsAllowed({
        webgl2Available: Boolean(gl),
        reducedTransparency: false,
        increasedContrast: false,
      }) ||
      !gl
    ) {
      markState("fallback", "webgl2");
      return clearState;
    }

    let program: WebGLProgram;
    try {
      program = createProgram(gl);
    } catch (error) {
      markState("fallback", "shader");
      console.warn("[compact-glass] SDF 光学层已回退", error);
      return clearState;
    }

    const shapeA = gl.getUniformLocation(program, "u_shapeA");
    const shapeB = gl.getUniformLocation(program, "u_shapeB");
    const radiusA = gl.getUniformLocation(program, "u_radiusA");
    const radiusB = gl.getUniformLocation(program, "u_radiusB");
    const shapeCount = gl.getUniformLocation(program, "u_shapeCount");
    const pixelRatio = gl.getUniformLocation(program, "u_pixelRatio");
    const dark = gl.getUniformLocation(program, "u_dark");
    const native = gl.getUniformLocation(program, "u_nativeBackdrop");
    const missingUniforms = [
      ["u_shapeA", shapeA],
      ["u_shapeB", shapeB],
      ["u_radiusA", radiusA],
      ["u_radiusB", radiusB],
      ["u_shapeCount", shapeCount],
      ["u_pixelRatio", pixelRatio],
      ["u_dark", dark],
      ["u_nativeBackdrop", native],
    ].flatMap(([name, location]) => (location ? [] : [name]));
    if (missingUniforms.length > 0) {
      console.warn(
        "[compact-glass] shader uniform contract is incomplete",
        missingUniforms.join(", "),
      );
      gl.deleteProgram(program);
      markState("fallback", "uniforms");
      return clearState;
    }

    let frameRequest = 0;
    let disposed = false;
    const draw = () => {
      frameRequest = 0;
      if (disposed || gl.isContextLost()) return;
      const bounds = canvas.getBoundingClientRect();
      const frame = compactGlassFrame(bounds.width, bounds.height, window.devicePixelRatio);
      if (!frame) return;
      if (canvas.width !== frame.pixelWidth) canvas.width = frame.pixelWidth;
      if (canvas.height !== frame.pixelHeight) canvas.height = frame.pixelHeight;

      gl.viewport(0, 0, frame.pixelWidth, frame.pixelHeight);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      const canvasBounds = canvas.getBoundingClientRect();
      const shapeElements = layout === "split" ? sideSurfaces : [canvas];
      const geometry = compactGlassShapes(
        canvasBounds,
        shapeElements.map((element) => element.getBoundingClientRect()),
        frame.pixelRatio,
      );
      const shapes = geometry?.shapes ?? [];
      if (!compactGlassGeometryReady(layout, shapes.length)) {
        markState("fallback", "geometry");
        return;
      }
      const first = shapes[0];
      const second = shapes[1] ?? first;
      gl.uniform4f(
        shapeA,
        first.centerX,
        first.centerY,
        first.halfWidth,
        first.halfHeight,
      );
      gl.uniform4f(
        shapeB,
        second.centerX,
        second.centerY,
        second.halfWidth,
        second.halfHeight,
      );
      gl.uniform1f(radiusA, first.radius);
      gl.uniform1f(radiusB, second.radius);
      gl.uniform1i(shapeCount, Math.min(2, shapes.length));
      gl.uniform1f(pixelRatio, frame.pixelRatio);
      gl.uniform1f(dark, mediaQueryMatches("(prefers-color-scheme: dark)") ? 1 : 0);
      gl.uniform1f(native, nativeBackdrop ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      markState("ready");
    };
    const scheduleDraw = () => {
      if (frameRequest || disposed) return;
      frameRequest = window.requestAnimationFrame(draw);
    };
    const resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(scheduleDraw)
      : undefined;
    resizeObserver?.observe(canvas);
    sideSurfaces.forEach((surface) => resizeObserver?.observe(surface));
    window.addEventListener("resize", scheduleDraw);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") scheduleDraw();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const onContextLost = (event: Event) => {
      event.preventDefault();
      markState("fallback", "context-lost");
    };
    const onContextRestored = () => setMediaRevision((value) => value + 1);
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);
    scheduleDraw();

    return () => {
      disposed = true;
      if (frameRequest) window.cancelAnimationFrame(frameRequest);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleDraw);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      if (!gl.isContextLost()) gl.deleteProgram(program);
      clearState();
    };
  }, [layout, mediaRevision, nativeBackdrop]);

  return (
    <canvas
      ref={canvasRef}
      className="widget-compact-sdf-glass"
      data-compact-glass-layer="optics"
      data-optics-regions="centre-inner-outer"
      data-refraction-model="dual-interface-response"
      aria-hidden="true"
    />
  );
}
