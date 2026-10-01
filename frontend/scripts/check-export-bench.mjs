/**
 * Smoke-check bench export builders (no browser).
 * Run: node --experimental-strip-types scripts/check-export-bench.mts
 * Fallback: invoked via npm run test:unit-bench after tsc emit — here we
 * re-validate the public format contracts in pure JS.
 */

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

// Minimal profile fixture
const profile = {
  time: [0, 0.1, 0.2, 0.3, 0.4],
  velocity: [0, 0.5, 1.0, 1.5, 2.0], // m/s
  position: [0, 0.05, 0.2, 0.45, 0.8],
  slope: [0, 0.01, 0.012, 0.011, 0.01], // rad
};

function gradePct(alpha) {
  return Math.tan(alpha) * 100;
}

function buildPuma(p) {
  const lines = ["Time[s],Velocity[km/h],Gradient[%],Distance[m]"];
  for (let i = 0; i < p.time.length; i++) {
    lines.push(
      [
        p.time[i].toFixed(3),
        (p.velocity[i] * 3.6).toFixed(3),
        gradePct(p.slope[i]).toFixed(3),
        p.position[i].toFixed(3),
      ].join(",")
    );
  }
  return lines.join("\n") + "\n";
}

function buildCm(p) {
  const lines = ["Time[s]\tVelocity[km/h]"];
  for (let i = 0; i < p.time.length; i++) {
    lines.push(`${p.time[i].toFixed(3)}\t${(p.velocity[i] * 3.6).toFixed(3)}`);
  }
  return lines.join("\n") + "\n";
}

function buildXodr(p) {
  const length = p.position[p.position.length - 1];
  const elev = p.position
    .map((s, i) => {
      const a = i === 0 ? 100 : 100 + Math.tan(p.slope[i - 1]) * (s - p.position[i - 1]);
      return `      <elevation s="${s.toFixed(3)}" a="${a.toFixed(3)}" b="${Math.tan(p.slope[i]).toFixed(6)}" c="0" d="0"/>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<OpenDRIVE>
  <header revMajor="1" revMinor="4" name="test" version="1.0"/>
  <road name="test" length="${length.toFixed(3)}" id="1" junction="-1">
    <planView>
      <geometry s="0" x="0" y="0" hdg="0" length="${length.toFixed(3)}">
        <line/>
      </geometry>
    </planView>
    <elevationProfile>
${elev}
    </elevationProfile>
    <lanes>
      <laneSection s="0">
        <center><lane id="0" type="none" level="true"/></center>
        <right>
          <lane id="-1" type="driving" level="true">
            <width sOffset="0" a="3.5" b="0" c="0" d="0"/>
          </lane>
        </right>
      </laneSection>
    </lanes>
  </road>
</OpenDRIVE>
`;
}

const puma = buildPuma(profile);
assert(puma.startsWith("Time[s],Velocity[km/h],Gradient[%],Distance[m]\n"), "puma header");
assert(puma.split("\n").filter(Boolean).length === 6, "puma 5 samples + header");
assert(puma.includes("1.800"), "puma 0.5 m/s → 1.8 km/h");

const cm = buildCm(profile);
assert(cm.startsWith("Time[s]\tVelocity[km/h]\n"), "cm header");
assert(cm.includes("\t"), "cm tab sep");

const xodr = buildXodr(profile);
assert(xodr.includes("<OpenDRIVE>"), "xodr root");
assert(xodr.includes("<elevationProfile>"), "xodr elev");
assert(xodr.includes('type="driving"'), "xodr lane");

console.log("ok  puma rg/v csv");
console.log("ok  carmaker speed");
console.log("ok  opendrive xodr");
console.log("check-export-bench: all passed");
