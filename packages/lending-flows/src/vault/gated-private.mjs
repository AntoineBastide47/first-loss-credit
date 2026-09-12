// Gated Private Vault
//
// Gate vault DEPOSITORS and SHARE HOLDERS by credential. A credentialed member
// deposits successfully; a non-member is rejected with tecNO_AUTH.
//
// Scope (important): a private vault gates depositors and share ownership only.
// LoanSet has NO DomainID or credential field, so the protocol does NOT gate loan
// borrowers. Borrower eligibility is application logic. This flow does not claim
// protocol borrower gating.
//
// Independence: this flow funds its own issuer, member, outsider, and vaultOwner,
// and builds its own credential, domain, and private vault from the shared lib. It
// imports no other flow.
//
// Run:  node src/vault/gated-private.mjs

import { convertStringToHex, VaultCreateFlags, dropsToXrp } from "xrpl";
import {
  connect,
  fundAccounts,
  submitExpectingFailure,
  readVault,
  logFriction,
} from "../lib/index.mjs";
import { assert, makeRecorder, createVault, vaultDeposit, shareBalance } from "../lib/lending.mjs";
import {
  issueAcceptedCredential,
  createCredential,
  acceptedCredential,
  setPermissionedDomain,
} from "../lib/credentials.mjs";

const DEPOSIT_DROPS = "40000000"; // 40 XRP

async function main() {
  const client = await connect();
  console.log(`connected: ${client.connection.getUrl?.() ?? "ok"}`);
  const { record, printLinks } = makeRecorder();

  try {
    // Preconditions: issuer (credential + domain owner), member, outsider, vaultOwner,
    // and a pending holder for the unaccepted-credential control.
    const [issuer, member, outsider, vaultOwner, pending] = await fundAccounts(client, 5);
    console.log(`issuer=${issuer.address}\nmember=${member.address}\noutsider=${outsider.address}` +
      `\nvaultOwner=${vaultOwner.address}\npending=${pending.address}`);

    const credentialType = convertStringToHex("KYC_ACCREDITED");

    // Issue + accept the member's credential; build a domain that accepts it.
    const cred = await issueAcceptedCredential(client, { issuer, subject: member, credentialType });
    record("CredentialCreate", cred.createHash);
    record("CredentialAccept", cred.acceptHash);

    const { hash: domainHash, domainId } = await setPermissionedDomain(client, issuer, [
      acceptedCredential(issuer.address, credentialType),
    ]);
    record("PermissionedDomainSet", domainHash);
    console.log(`  DomainID=${domainId}`);

    // Step 1: private vault bound to the domain (Asset as an object; bare "XRP" fails).
    const { hash: vaultHash, vaultId, shareMptId, vault: created } = await createVault(client, vaultOwner, {
      asset: { currency: "XRP" },
      flags: VaultCreateFlags.tfVaultPrivate,
      domainId,
    });
    record("VaultCreate", vaultHash);
    console.log(`  VaultID=${vaultId}\n  ShareMPTID=${shareMptId}`);
    assert((Number(created.Flags ?? 0) & VaultCreateFlags.tfVaultPrivate) !== 0,
      "vault carries tfVaultPrivate");
    // The domain binding lives on the share MPTokenIssuance: gating share ownership
    // is how XLS-65 restricts depositors.
    assert(created.shares?.DomainID === domainId, "share issuance carries the DomainID");

    // Step 2: member deposit -> success; member receives shares; assets rise.
    const before = await readVault(client, vaultId);
    const memberDeposit = await vaultDeposit(client, member, vaultId, DEPOSIT_DROPS);
    record("VaultDeposit(member)", memberDeposit.hash);
    const after = await readVault(client, vaultId);
    const memberShares = await shareBalance(client, member.address, shareMptId);
    console.log(`  member shares=${memberShares} AssetsTotal ${before.AssetsTotal ?? "0"} -> ${after.AssetsTotal}`);
    assert(BigInt(memberShares) > 0n, "member received share MPT");
    assert(BigInt(after.AssetsTotal) === BigInt(before.AssetsTotal ?? "0") + BigInt(DEPOSIT_DROPS),
      "AssetsTotal rose by the member deposit");
    assert(BigInt(after.AssetsAvailable) === BigInt(before.AssetsAvailable ?? "0") + BigInt(DEPOSIT_DROPS),
      "AssetsAvailable rose by the member deposit");

    // Step 3: outsider deposit -> tecNO_AUTH (outsider is well funded, so the failure
    // is authorization, not balance).
    const outsiderTry = await submitExpectingFailure(client, {
      TransactionType: "VaultDeposit", Account: outsider.address, VaultID: vaultId, Amount: DEPOSIT_DROPS,
    }, outsider);
    if (outsiderTry.hash) record("VaultDeposit(outsider) rejected", outsiderTry.hash);
    console.log(`  outsider deposit -> ${outsiderTry.code}`);
    assert(outsiderTry.code === "tecNO_AUTH", "outsider (no credential) rejected with tecNO_AUTH");

    // Control: an UNACCEPTED matching credential must also fail authorization.
    const pendingCreate = await createCredential(client, issuer, { subject: pending, credentialType });
    record("CredentialCreate(pending, unaccepted)", pendingCreate.hash);
    const pendingTry = await submitExpectingFailure(client, {
      TransactionType: "VaultDeposit", Account: pending.address, VaultID: vaultId, Amount: DEPOSIT_DROPS,
    }, pending);
    if (pendingTry.hash) record("VaultDeposit(pending) rejected", pendingTry.hash);
    console.log(`  pending (unaccepted credential) deposit -> ${pendingTry.code}`);
    assert(pendingTry.code === "tecNO_AUTH", "unaccepted credential rejected with tecNO_AUTH");

    console.log(`\nMember deposited ${dropsToXrp(DEPOSIT_DROPS)} XRP into the private vault; ` +
      `outsider and unaccepted-credential holder were both denied.`);
    printLinks();

    // Friction to capture.
    logFriction({
      flow: "vault/gated-private", surface: "protocol", feature: "xls-65", tx_type: "LoanSet",
      note: "Private-vault gating covers depositors and share holders only. LoanSet has no DomainID/credential field, so borrowers are not gated by the protocol; borrower eligibility is application logic.",
    });

    console.log("\nComplete: credential-gated deposits enforced (tecNO_AUTH for non-members).");
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  logFriction({ flow: "vault/gated-private", error: e.message, code: e.code });
  console.error("\nFAILED:", e.message);
  if (e.res?.result?.meta) console.error(JSON.stringify(e.res.result.meta, null, 2));
  process.exit(1);
});
