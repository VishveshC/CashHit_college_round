const args = process.argv.slice(2);
let target;
let mock = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--target" && target === undefined) target = args[++i];
  else if (args[i] === "--mock-randomness") mock = true;
  else throw new Error("Unknown or duplicate build-gate argument.");
}
if (target !== "local" && target !== "public") throw new Error("Explicit --target local or public is required.");
if (target === "public" && mock) throw new Error("DEMO ONLY MockRandomness cannot enter a public build.");
if (target === "public") throw new Error("No approved production adapter or public deployment configuration exists.");
console.log("PASS: local-only chain 31337 build gate; demo adapter permitted locally. Public release remains blocked.");
