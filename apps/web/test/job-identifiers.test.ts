import assert from "node:assert/strict";
import { test } from "node:test";
import { extractCreatedJobIdentifier, parseJobIdentifier } from "../lib/client/job-identifiers.ts";

const maxUint256 = (1n << 256n) - 1n;

test("job identifiers accept canonical unsigned decimal values through uint256 max, including zero", () => {
  assert.equal(parseJobIdentifier("0"), 0n);
  assert.equal(parseJobIdentifier("1"), 1n);
  assert.equal(parseJobIdentifier(maxUint256.toString()), maxUint256);
});

test("job identifiers reject malformed, signed, fractional, leading-zero, and out-of-range values", () => {
  for (const value of ["", "00", "01", "-1", "+1", " 1", "1 ", "1.0", "1e2", "0x01", "-0", (maxUint256 + 1n).toString(), null, undefined, 0, 1n]) {
    assert.equal(parseJobIdentifier(value), null, `unexpectedly accepted ${String(value)}`);
  }
});

test("JobCreated extraction preserves event ID zero and rejects absent or malformed event IDs", () => {
  assert.equal(extractCreatedJobIdentifier([{ eventName: "JobCreated", args: { jobId: 0n } }]), 0n);
  assert.equal(extractCreatedJobIdentifier([{ eventName: "JobCreated", args: { jobId: 42n } }]), 42n);
  assert.equal(extractCreatedJobIdentifier([{ eventName: "OtherEvent", args: { jobId: 1n } }]), null);
  assert.equal(extractCreatedJobIdentifier([{ eventName: "JobCreated", args: {} }]), null);
  assert.equal(extractCreatedJobIdentifier([{ eventName: "JobCreated", args: { jobId: maxUint256 + 1n } }]), null);
});
