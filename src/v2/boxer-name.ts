import { randomInt } from "node:crypto";

// Fictional ring names with a software-flavored nod to boxing greats.
export const BOXER_NAMES = [
  "muhammad-cli",
  "mike-byteson",
  "joe-cachezier",
  "george-forkman",
  "sugar-ray-loggin",
  "evander-holyfieldbus",
  "lennox-linux",
  "manny-packetiao",
  "floyd-middleware",
  "rocky-marcianoop",
  "oscar-de-la-shell",
  "saul-canelo-arrayvez",
  "tyson-query",
  "oleksandr-usync",
  "anthony-jobqueue",
  "deontay-builder",
  "daniel-debugois",
  "joseph-parser",
  "zhilei-zshang",
  "joe-joystick",
  "andy-ruizip",
  "terence-cacheford",
  "naoya-inqueue",
  "dmitry-bivolatile",
  "artur-beterbyte",
  "gervonta-dataviz",
  "shakur-stackenson",
  "devin-hashney",
  "ryan-garcia256",
  "teofimo-loops",
  "vasiliy-lomachecko",
  "oleksandr-gitvozdyk",
  "jesse-bam-ramirez",
  "jaron-async-ennis",
  "vergil-sortriz",
  "sebastian-fundarray",
  "david-benaevents",
  "chris-eubank-json",
  "conor-benchmark",
  "katie-tailor",
  "amanda-threadano",
  "claressa-shields-up",
  "alycia-bytegarner",
  "mikaela-memlayer",
  "chantelle-cacheeron",
  "savannah-marshallock",
  "lauren-price-check",
  "skye-nicolldown",
] as const;

export function generateBoxerName(takenNames: Iterable<string>): string {
  const taken = new Set(Array.from(takenNames, (name) => name.toLowerCase()));
  const available = BOXER_NAMES.filter((name) => !taken.has(name));
  if (available.length) return available[randomInt(available.length)]!;
  const base = BOXER_NAMES[randomInt(BOXER_NAMES.length)]!;
  let round = 2;
  while (taken.has(`${base}-${round}`)) round++;
  return `${base}-${round}`;
}
