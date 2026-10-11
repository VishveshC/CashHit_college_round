# Randomness adapter plan — Phase 0

Official documentation inspected on 2026-10-10:
- https://docs.chain.link/vrf/v2-5/subscription/get-a-random-number
- https://docs.chain.link/vrf/v2-5/security

Candidate future provider: Chainlink VRF v2.5 subscription method. The documented integration uses VRFConsumerBaseV2Plus, VRFV2PlusClient.RandomWordsRequest, coordinator requestRandomWords and consumer fulfillRandomWords. Subscription funding and consumer authorization are separate from user escrow. No provider package, address, subscription, or public deployment is configured in this scaffold.

Important integration conflict: provider guidance prohibits re-requesting/cancelling randomness because selecting between results can bias outcomes. D-08 requires bounded retries. Therefore a production integration is BLOCKED until provider-safe semantics are specified and reviewed. This is not a blocker for the explicitly local-only demo using a DEMO ONLY mock. No production-security claim is made.

Future local adapter must bind request identifiers to dispute, round, purpose and attempt, accept only the active authenticated request, ignore stale/duplicate callbacks, and never let the requester choose a seed. Callback handling stores randomness only; permissionless advancement performs bounded selection. After two retries and expiry of the third attempt, resolve 50/50 with full posted-deposit refunds. Registry exhaustion must also have a deterministic exit, recorded in the state-machine decisions.

No mock implementation or panel selection exists in Phase 0. F-32 remains unverified. A mock is not verifiable randomness. Public deployment remains out of scope.

## Phase 3 verification and local seam (2026-10-11)

Rechecked the official [VRF security page](https://docs.chain.link/vrf/v2-5/security) and [subscription integration guide](https://docs.chain.link/vrf/v2-5/subscription/get-a-random-number). Security guidance still rules out retries/cancellation of randomness requests, warns against changing outcome inputs after requests, and recommends separating entropy receipt from complex processing. The integration guide still describes a funded subscription/coordinator consumer setup. No provider package/address/subscription or public deployment was added. The D-08 retry conflict therefore remains unresolved for production.

A-28 through A-35 specify the local immutable engine/adapter, request-time candidate snapshots retained through retries, consumer-reserved IDs and authenticated entropy-only callbacks. The DEMO mock takes no caller-supplied word or timing-dependent seed; its deterministic entropy is predictable and is not VRF. Tests can impersonate the adapter only through Foundry cheatcodes. All public builds are fail-closed by scripts/public-build-check.mjs; current web scaffold build is not a usable production escrow. Actual Phase 3 source/test verification will be recorded in PHASE3_REPORT.md.
