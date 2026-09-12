// Permissioned Domain
//
// Create a permissioned domain that accepts a credential, then prove membership
// STANDALONE: a subject holding an accepted matching credential is a domain member,
// a non-holder is not. No gated action and no other flow is used for the proof.
//
// Design (verified): PermissionedDomainSet.AcceptedCredentials is a list of WRAPPED
// entries, [{ Credential: { Issuer, CredentialType } }]. The flat { Issuer,
// CredentialType } form fails validation. Membership = holding an ACCEPTED credential
// matching one entry in the list.
//
// Independence: this flow funds its own issuer, member, and outsider, issues and
// accepts the member's credential via the shared credential builder, and proves
// membership by itself. It imports no other flow.
//
// Run:  node src/credentials/permissioned-domain.mjs

import { convertStringToHex } from "xrpl";
import { connect, fundAccounts, logFriction } from "../lib/index.mjs";
import { assert, makeRecorder } from "../lib/lending.mjs";
import {
  issueAcceptedCredential,
  readCredential,
  isAccepted,
  acceptedCredential,
  setPermissionedDomain,
  readPermissionedDomain,
} from "../lib/credentials.mjs";

/** True if the domain's accepted list contains an entry for (issuer, credentialType). */
function domainAccepts(domain, issuer, credentialType) {
  return (domain.AcceptedCredentials || []).some(
    (e) => e.Credential?.Issuer === issuer && e.Credential?.CredentialType === credentialType,
  );
}

async function main() {
  const client = await connect();
  console.log(`connected: ${client.connection.getUrl?.() ?? "ok"}`);
  const { record, printLinks } = makeRecorder();

  try {
    // Preconditions: issuer (credential issuer + domain owner), member, outsider.
    const [issuer, member, outsider] = await fundAccounts(client, 3);
    console.log(`issuer=${issuer.address}\nmember=${member.address}\noutsider=${outsider.address}`);

    const credentialType = convertStringToHex("KYC_ACCREDITED");
    console.log(`  CredentialType=KYC_ACCREDITED -> ${credentialType}`);

    // Precondition: issue and accept the member's credential (reuses the credential issue-and-accept procedure).
    const cred = await issueAcceptedCredential(client, {
      issuer, subject: member, credentialType,
    });
    record("CredentialCreate", cred.createHash);
    record("CredentialAccept", cred.acceptHash);
    assert(isAccepted(cred.credential), "member credential accepted (precondition)");

    // Step 1: PermissionedDomainSet (issuer owns the domain). Wrapped accepted list.
    const { hash: domainHash, domainId } = await setPermissionedDomain(client, issuer, [
      acceptedCredential(issuer.address, credentialType),
    ]);
    record("PermissionedDomainSet", domainHash);
    console.log(`  DomainID=${domainId}`);

    // Step 2: standalone membership proof.
    // (a) The domain accepts (issuer, CredentialType) in the wrapped form.
    const domain = await readPermissionedDomain(client, domainId);
    assert(domain.Owner === issuer.address, "PermissionedDomain.Owner == issuer");
    assert(domainAccepts(domain, issuer.address, credentialType),
      "domain accepted list contains { Credential: { Issuer, CredentialType } }");

    // (b) The member holds an accepted credential matching that issuer + type.
    const memberCred = await readCredential(client, {
      issuer: issuer.address, subject: member.address, credentialType,
    });
    assert(memberCred !== null, "member holds the credential");
    assert(isAccepted(memberCred), "member credential is accepted");
    assert(memberCred.Issuer === issuer.address && memberCred.CredentialType === credentialType,
      "member credential matches the domain's accepted issuer + type");
    console.log("  -> member qualifies for the domain");

    // (c) The outsider holds no such accepted credential.
    const outsiderCred = await readCredential(client, {
      issuer: issuer.address, subject: outsider.address, credentialType,
    });
    assert(outsiderCred === null, "outsider holds no matching credential -> not a member");
    console.log("  -> outsider does not qualify");

    console.log("\nPermissionedDomain object:");
    console.log(JSON.stringify({
      index: domain.index,
      Owner: domain.Owner,
      AcceptedCredentials: domain.AcceptedCredentials,
      Sequence: domain.Sequence,
    }, null, 2));

    printLinks();

    // Friction to capture.
    logFriction({
      flow: "credentials/permissioned-domain", surface: "sdk", feature: "permissioned-domains", tx_type: "PermissionedDomainSet",
      note: "AcceptedCredentials requires the wrapped { Credential: { Issuer, CredentialType } } form; the flat { Issuer, CredentialType } fails xrpl.js validation. Not obvious without the model.",
    });
    logFriction({
      flow: "credentials/permissioned-domain", surface: "protocol", feature: "permissioned-domains", tx_type: null,
      note: "Membership is readable directly: the PermissionedDomain object lists accepted (Issuer, CredentialType) and the Credential object carries the accepted flag. No gated action is needed to confirm it.",
    });

    console.log("\nComplete: domain accepts the credential; member qualifies, outsider does not.");
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  logFriction({ flow: "credentials/permissioned-domain", error: e.message, code: e.code });
  console.error("\nFAILED:", e.message);
  if (e.res?.result?.meta) console.error(JSON.stringify(e.res.result.meta, null, 2));
  process.exit(1);
});
