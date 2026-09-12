// Credential Issuance
//
// Issue a credential from an issuer to a subject (CredentialCreate), then have the
// subject accept it (CredentialAccept). This is the membership primitive that gates
// vault depositors in later flows.
//
// Design (verified): CredentialCreate issues ONE credential instance to ONE subject.
// It does NOT define a reusable credential type; CredentialType is a hex label
// carried on the instance. The Credential ledger object is keyed by
// (Issuer, Subject, CredentialType). It is created unaccepted; CredentialAccept sets
// the lsfAccepted flag. Only an accepted credential satisfies a permissioned domain.
//
// Independence: this flow funds its own issuer and subject and ends with an accepted
// credential it hands to no other flow. It imports no other flow.
//
// Run:  node src/credentials/issuance.mjs

import { convertStringToHex } from "xrpl";
import { connect, fundAccounts, logFriction } from "../lib/index.mjs";
import { assert, makeRecorder } from "../lib/lending.mjs";
import {
  createCredential,
  acceptCredential,
  readCredential,
  isAccepted,
} from "../lib/credentials.mjs";

async function main() {
  const client = await connect();
  console.log(`connected: ${client.connection.getUrl?.() ?? "ok"}`);
  const { record, printLinks } = makeRecorder();

  try {
    // Precondition: fund issuer and subject.
    const [issuer, subject] = await fundAccounts(client, 2);
    console.log(`issuer=${issuer.address}\nsubject=${subject.address}`);

    // CredentialType and URI must be hex-encoded (xrpl.js and the ledger reject raw
    // ASCII). Encode the human labels here.
    const credentialType = convertStringToHex("KYC_ACCREDITED");
    const uri = convertStringToHex("https://issuer.example/kyc/accredited");
    console.log(`  CredentialType=KYC_ACCREDITED -> ${credentialType}`);

    // Step 1: CredentialCreate (issuer -> subject).
    const create = await createCredential(client, issuer, { subject, credentialType, uri });
    record("CredentialCreate", create.hash);

    // The instance exists immediately, keyed by (Issuer, Subject, CredentialType),
    // but is NOT yet accepted.
    const beforeAccept = await readCredential(client, {
      issuer: issuer.address, subject: subject.address, credentialType,
    });
    assert(beforeAccept !== null, "Credential object exists after CredentialCreate");
    assert(beforeAccept.Issuer === issuer.address, "Credential.Issuer == issuer");
    assert(beforeAccept.Subject === subject.address, "Credential.Subject == subject");
    assert(beforeAccept.CredentialType === credentialType, "Credential.CredentialType == label");
    assert(!isAccepted(beforeAccept),
      "Credential is unaccepted before CredentialAccept (lsfAccepted clear)");

    // Step 2: CredentialAccept (subject).
    const accept = await acceptCredential(client, subject, { issuer, credentialType });
    record("CredentialAccept", accept.hash);

    // The same object is now accepted.
    const afterAccept = await readCredential(client, {
      issuer: issuer.address, subject: subject.address, credentialType,
    });
    assert(afterAccept !== null, "Credential object still exists after CredentialAccept");
    assert(isAccepted(afterAccept),
      "Credential is accepted after CredentialAccept (lsfAccepted set)");

    console.log("\nAccepted Credential object:");
    console.log(JSON.stringify({
      index: afterAccept.index,
      Issuer: afterAccept.Issuer,
      Subject: afterAccept.Subject,
      CredentialType: afterAccept.CredentialType,
      Flags: afterAccept.Flags,
      URI: afterAccept.URI,
    }, null, 2));

    printLinks();

    // Friction to capture.
    logFriction({
      flow: "credentials/issuance", surface: "docs", feature: "credentials", tx_type: "CredentialCreate",
      note: "CredentialCreate issues one instance per subject; CredentialType is a label on the instance, not a separate reusable type object. No type object is created.",
    });
    logFriction({
      flow: "credentials/issuance", surface: "sdk", feature: "credentials", tx_type: "CredentialCreate",
      note: "CredentialType and URI must be hex-encoded; xrpl.js validation rejects raw ASCII with 'must be encoded in hex'. convertStringToHex handles it.",
    });

    console.log("\nComplete: credential issued and accepted (lsfAccepted set).");
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  logFriction({ flow: "credentials/issuance", error: e.message, code: e.code });
  console.error("\nFAILED:", e.message);
  if (e.res?.result?.meta) console.error(JSON.stringify(e.res.result.meta, null, 2));
  process.exit(1);
});
