import fs from "node:fs";

const path = "lib/orbScene.ts";
let source = fs.readFileSync(path, "utf8");

const oldRotate = `  function rotateBy(deltaTheta: number, deltaPhi: number) {
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
`;

const newRotate = `  function rotateBy(deltaTheta: number, deltaPhi: number) {
    // Gesture control rotates the actual 3D orb, not the camera.
    // Horizontal hand motion turns around Y; vertical motion turns around X.
    orbGroup.rotation.y += deltaTheta;
    orbGroup.rotation.x += deltaPhi;
  }
`;

if (!source.includes(oldRotate)) {
  throw new Error("Could not find rotateBy block in lib/orbScene.ts");
}
source = source.replace(oldRotate, newRotate);

const oldReset = `  function resetView() {
    camera.position.copy(HOME_POSITION);
    controls.target.set(0, 0, 0);
    camera.lookAt(controls.target);
    controls.update();
  }
`;

const newReset = `  function resetView() {
    camera.position.copy(HOME_POSITION);
    controls.target.set(0, 0, 0);
    orbGroup.rotation.set(0, 0, 0);
    camera.lookAt(controls.target);
    controls.update();
  }
`;

if (!source.includes(oldReset)) {
  throw new Error("Could not find resetView block in lib/orbScene.ts");
}
source = source.replace(oldReset, newReset);

fs.writeFileSync(path, source);
console.log("Gesture deployment patch applied: direct 3D orb rotation enabled.");
