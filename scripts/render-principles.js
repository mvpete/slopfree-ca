// Refresh the Human First Design section in index.html from principles/*.md.
// The deploy does this automatically; run it locally to preview: npm run principles
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./lib/config.js";
import { readPrinciples, injectPrinciples } from "./lib/principles.js";

const file = path.join(REPO, "index.html");
const list = readPrinciples(REPO);
fs.writeFileSync(file, injectPrinciples(fs.readFileSync(file, "utf8"), list));
console.log(`index.html: ${list.length} principles`);
