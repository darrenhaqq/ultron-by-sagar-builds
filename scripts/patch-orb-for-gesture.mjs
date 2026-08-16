import fs from "node:fs";

const path = "lib/orbScene.ts";
let source = fs.readFileSync(path, "utf8");

function replaceExact(label, before, after) {
  if (!source.includes(before)) {
    throw new Error(`Could not apply ${label} patch in lib/orbScene.ts`);
  }
  source = source.replace(before, after);
}

replaceExact(
  "mobile renderer",
  `  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
`,
  `  // Preserve the full interaction model on phones while spending less GPU
  // budget on invisible pixel density and decorative effects.
  const compactDevice = window.matchMedia(
    "(max-width: 900px), (pointer: coarse)",
  ).matches;
  const maxPixelRatio = compactDevice ? 1.3 : 1.8;
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
`,
);

replaceExact(
  "mobile bloom",
  `  const bloom = new UnrealBloomPass(
    new THREE.Vector2(width, height),
    1.8, // strength
    0.4, // radius
    0.2, // threshold
  );
`,
  `  const bloom = new UnrealBloomPass(
    new THREE.Vector2(width, height),
    compactDevice ? 1.25 : 1.8,
    compactDevice ? 0.28 : 0.4,
    0.2,
  );
`,
);

replaceExact(
  "mobile chromatic aberration",
  `      uIntensity: { value: 0.003 },
`,
  `      uIntensity: { value: compactDevice ? 0.0015 : 0.003 },
`,
);

replaceExact(
  "mobile debris count",
  `  const debris: THREE.Mesh[] = [];
  for (let i = 0; i < 250; i++) {
`,
  `  const debris: THREE.Mesh[] = [];
  const debrisCount = compactDevice ? 120 : 250;
  for (let i = 0; i < debrisCount; i++) {
`,
);

replaceExact(
  "mobile dust count",
  `  const dustCount = 2000;
`,
  `  const dustCount = compactDevice ? 900 : 2000;
`,
);

replaceExact(
  "mobile bloom animation",
  `    bloom.strength = 1.6 + Math.sin(t * 0.8) * 0.3;
`,
  `    bloom.strength = compactDevice
      ? 1.15 + Math.sin(t * 0.8) * 0.16
      : 1.6 + Math.sin(t * 0.8) * 0.3;
`,
);

replaceExact(
  "direct orb rotation",
  `  function rotateBy(deltaTheta: number, deltaPhi: number) {
    offsetScratch.copy(camera.position).sub(controls.target);
    sphericalScratch.setFromVector3(offsetScratch);
    sphericalScratch.theta -= deltaTheta;
    sphericalScratch.phi = THREE.MathUtils.clamp(
      sphericalScratch.phi - deltaPhi,
      0.05,
      Math.PI - 0.05,
    );
    sphericalScratch.makeSafe();
    offsetScratch.setFromSpherical(sphericalScratch);
    camera.position.copy(controls.target).add(offsetScratch);
    camera.lookAt(controls.target);
  }
`,
  `  function rotateBy(deltaTheta: number, deltaPhi: number) {
    // Gesture control rotates the actual 3D orb, not the camera.
    orbGroup.rotation.y += deltaTheta;
    orbGroup.rotation.x += deltaPhi;
  }
`,
);

replaceExact(
  "orb reset",
  `  function resetView() {
    camera.position.copy(HOME_POSITION);
    controls.target.set(0, 0, 0);
    camera.lookAt(controls.target);
    controls.update();
  }
`,
  `  function resetView() {
    camera.position.copy(HOME_POSITION);
    controls.target.set(0, 0, 0);
    orbGroup.rotation.set(0, 0, 0);
    camera.lookAt(controls.target);
    controls.update();
  }
`,
);

fs.writeFileSync(path, source);
console.log(
  "Jarvis deployment patch applied: direct orb rotation + mobile GPU budget enabled.",
);
