// Phase 3.1 — MPT Issuance
//
// Issue an MPT suitable to be a vault asset and to authorize holders, including the
// two-step authorization path when the issuance requires auth:
//   holder opts in (MPTokenAuthorize) -> issuer authorizes the holder (MPTokenAuthorize).
// A holder cannot hold a positive balance until BOTH steps complete.
//
// AssetScale here is the MPT's OWN scale. It is separate from the vault share Scale
// (Part 3.2); mixing the two is a likely bug.
//
// Independence: this phase funds its own issuer and holders and ends with an
// authorized MPT it hands to no other phase. It imports no other phase.
//
// Run:  node part-3/3.1_mpt_issuance.mjs

import { convertStringToHex } from "xrpl";
import {
  connect,
  fundAccounts,
  submitAndWait,
  submitExpectingFailure,
  logFriction,
} from "../lib/index.mjs";
import { assert, makeRecorder } from "../lib/lending.mjs";
import {
  MPTokenIssuanceCreateFlags as F,
  createMptIssuance,
  authorizeMpt,
  readMptIssuance,
  readMptoken,
  mptBalance,
  isMptAuthorized,
} from "../lib/mpt.mjs";

const ASSET_SCALE = 2; // the MPT's own decimal scale, distinct from any vault share Scale
const SEND = "100"; // base units of the MPT to issue to a holder

async function main() {
  const client = await connect();
  console.log(`connected: ${client.connection.getUrl?.() ?? "ok"}`);
  const { record, printLinks } = makeRecorder();

  try {
    // Precondition: issuer, holderA (authorized path), holderB (unauthorized control).
    const [issuer, holderA, holderB] = await fundAccounts(client, 3);
    console.log(`issuer=${issuer.address}\nholderA=${holderA.address}\nholderB=${holderB.address}`);

    // Step 1: MPTokenIssuanceCreate. Transferable (so it can move between vault,
    // lenders, borrowers), gated (RequireAuth), and escrow-capable (Part 4 reuse).
    const flags = F.tfMPTCanTransfer | F.tfMPTRequireAuth | F.tfMPTCanEscrow;
    const { hash: createHash, issuanceId } = await createMptIssuance(client, issuer, {
      flags,
      assetScale: ASSET_SCALE,
      maximumAmount: "1000000000",
      transferFee: 0,
      // XLS-89: MPTokenMetadata must be hex-encoded JSON with ticker/name/icon/
      // asset_class/issuer_name for explorer and indexer discoverability.
      metadata: convertStringToHex(JSON.stringify({
        ticker: "FLC",
        name: "First Loss Credit MPT",
        icon: "https://example.com/flc.png",
        asset_class: "other",
        issuer_name: "First Loss Credit",
      })),
    });
    record("MPTokenIssuanceCreate", createHash);
    console.log(`  MPTokenIssuanceID=${issuanceId}`);

    const issuance = await readMptIssuance(client, issuanceId);
    assert((Number(issuance.Flags) & F.tfMPTCanTransfer) !== 0, "issuance has tfMPTCanTransfer");
    assert((Number(issuance.Flags) & F.tfMPTRequireAuth) !== 0, "issuance has tfMPTRequireAuth");
    assert((Number(issuance.Flags) & F.tfMPTCanEscrow) !== 0, "issuance has tfMPTCanEscrow");
    assert(issuance.AssetScale === ASSET_SCALE, `issuance AssetScale == ${ASSET_SCALE}`);

    // Negative control: transfer to holderB, who never opted in, fails (auth required).
    const toUnopted = await submitExpectingFailure(client, {
      TransactionType: "Payment", Account: issuer.address, Destination: holderB.address,
      Amount: { mpt_issuance_id: issuanceId, value: SEND },
    }, issuer);
    if (toUnopted.hash) record("Payment->holderB rejected", toUnopted.hash);
    console.log(`  issue to non-opted-in holderB -> ${toUnopted.code}`);
    assert(toUnopted.code === "tecNO_AUTH", "transfer to a holder with no MPToken fails tecNO_AUTH");

    // Step 2: holderA opts in. MPToken exists, zero balance, not yet authorized.
    record("MPTokenAuthorize(holderA opt-in)", (await authorizeMpt(client, holderA, issuanceId)).hash);
    let tokA = await readMptoken(client, holderA, issuanceId);
    assert(tokA !== null, "holderA MPToken exists after opt-in");
    assert(!isMptAuthorized(tokA), "holderA MPToken not yet issuer-authorized");
    assert((await mptBalance(client, holderA, issuanceId)) === "0", "holderA balance 0 after opt-in");

    // Ordering proof: issue to holderA BEFORE the issuer authorizes -> still fails.
    const beforeAuth = await submitExpectingFailure(client, {
      TransactionType: "Payment", Account: issuer.address, Destination: holderA.address,
      Amount: { mpt_issuance_id: issuanceId, value: SEND },
    }, issuer);
    if (beforeAuth.hash) record("Payment->holderA (pre-auth) rejected", beforeAuth.hash);
    console.log(`  issue to opted-in but unauthorized holderA -> ${beforeAuth.code}`);
    assert(beforeAuth.code === "tecNO_AUTH", "issue before issuer-authorize fails tecNO_AUTH");
    assert((await mptBalance(client, holderA, issuanceId)) === "0", "holderA still 0 before authorize");

    // Step 3: issuer authorizes holderA.
    record("MPTokenAuthorize(issuer->holderA)",
      (await authorizeMpt(client, issuer, issuanceId, { holder: holderA })).hash);
    tokA = await readMptoken(client, holderA, issuanceId);
    assert(isMptAuthorized(tokA), "holderA MPToken issuer-authorized after step 3");

    // Now a positive balance is possible: issue to holderA succeeds.
    record("Payment->holderA (post-auth)", (await submitAndWait(client, {
      TransactionType: "Payment", Account: issuer.address, Destination: holderA.address,
      Amount: { mpt_issuance_id: issuanceId, value: SEND },
    }, issuer)).hash);
    const balA = await mptBalance(client, holderA, issuanceId);
    console.log(`  holderA balance after authorize + issue = ${balA}`);
    assert(balA === SEND, `holderA holds ${SEND} only after BOTH auth steps`);

    printLinks();

    // Friction to capture (plan 3.1).
    logFriction({
      phase: "3.1", surface: "protocol", feature: "mpt", tx_type: "MPTokenAuthorize",
      note: "With tfMPTRequireAuth, authorization is two MPTokenAuthorize txns with no flag difference: the holder opts in (Account=holder, no Holder) and the issuer authorizes (Account=issuer, Holder=holder). The direction is distinguished only by whether Holder is set.",
    });
    logFriction({
      phase: "3.1", surface: "docs", feature: "mpt", tx_type: "MPTokenIssuanceCreate",
      note: "tfMPT* flags and hex values (CanTransfer 0x20, RequireAuth 0x04, CanEscrow 0x08) are in the xrpl.js MPTokenIssuanceCreateFlags enum; the ledger object stores them at the same bit positions.",
    });

    console.log("\nPhase 3.1 complete: MPT issued; two-step auth enforced (balance only after both steps).");
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  logFriction({ phase: "3.1", error: e.message, code: e.code });
  console.error("\nFAILED:", e.message);
  if (e.res?.result?.meta) console.error(JSON.stringify(e.res.result.meta, null, 2));
  process.exit(1);
});
