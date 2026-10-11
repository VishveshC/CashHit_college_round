import assert from "node:assert/strict";
import test from "node:test";

import * as privateViewPolicy from "../lib/client/private-view-policy.ts";

test("private proposal confirmation includes every plaintext term beside its typed commitment", () => {
  const buildTerms = privateViewPolicy.buildPrivateConfirmationTerms as unknown as (
    content: { title: string; description: string; scope: string; deliveryRules: string; criteria: string[] },
    commitments: Record<string, string>,
  ) => string[];
  assert.equal(typeof buildTerms, "function", "the confirmation helper must be exported for the UI summary");
  if (typeof buildTerms !== "function") return;

  const content = {
    title: "Paint export",
    description: "Deliver the source file and preview.",
    scope: "Two annotated panels.",
    deliveryRules: "Upload a PDF before the due date.",
    criteria: ["Both panels have labels.", "<img src=x onerror=alert(1)>"] ,
  };
  const commitments = {
    title: `0x${"11".repeat(32)}`,
    description: `0x${"22".repeat(32)}`,
    scope: `0x${"33".repeat(32)}`,
    deliveryRules: `0x${"44".repeat(32)}`,
    "criteria.0": `0x${"55".repeat(32)}`,
    "criteria.1": `0x${"66".repeat(32)}`,
  };

  const terms = buildTerms(content, commitments);
  assert.ok(Array.isArray(terms));
  const requiredPairs = [
    [content.title, commitments.title],
    [content.description, commitments.description],
    [content.scope, commitments.scope],
    [content.deliveryRules, commitments.deliveryRules],
    [content.criteria[0], commitments["criteria.0"]],
    [content.criteria[1], commitments["criteria.1"]],
  ];
  for (const [plaintext, commitment] of requiredPairs) {
    assert.ok(terms.some((line) => line.includes(plaintext) && line.includes(commitment)), `confirmation is missing the plaintext/hash pair for ${plaintext}`);
  }
  assert.ok(terms.some((line) => line.includes(content.criteria[1])), "markup-like user content must stay literal text for React to render safely");
});
