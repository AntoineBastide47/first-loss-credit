// Shared, phase-agnostic builders for XLS-70 Credentials and XLS-80 Permissioned
// Domains: the membership primitives that gate vault depositors. These belong to no
// phase. A phase imports them like any library; it never imports another phase.

import { submitAndWait, readLedgerEntry } from "./index.mjs";
import { createdIndex } from "./lending.mjs";

// Credential ledger flag (ripple-binary-codec: lsfAccepted = 65536). CredentialCreate
// writes the object unaccepted; CredentialAccept sets this flag. Only an accepted
// credential satisfies a permissioned domain.
export const LSF_CREDENTIAL_ACCEPTED = 0x00010000;

/** True if a Credential ledger object has the accepted flag set. */
export const isAccepted = (cred) =>
  (Number(cred?.Flags ?? 0) & LSF_CREDENTIAL_ACCEPTED) !== 0;

/** Read the Credential object keyed by (issuer, subject, credentialType), or null. */
export async function readCredential(client, { issuer, subject, credentialType }) {
  try {
    const { result } = await client.request({
      command: "ledger_entry",
      credential: { issuer, subject, credential_type: credentialType },
      ledger_index: "validated",
    });
    return result.node;
  } catch (e) {
    if (e?.data?.error === "entryNotFound") return null;
    throw e;
  }
}

/**
 * CredentialCreate (issuer -> subject). CredentialType and URI must be hex-encoded
 * (the ledger and xrpl.js reject raw ASCII). opts: { uri?, expiration? }.
 * Returns { hash, meta }.
 */
export async function createCredential(client, issuer, { subject, credentialType, uri, expiration }) {
  const tx = {
    TransactionType: "CredentialCreate",
    Account: issuer.address,
    Subject: subject.address,
    CredentialType: credentialType,
  };
  if (uri) tx.URI = uri;
  if (expiration) tx.Expiration = expiration;
  return submitAndWait(client, tx, issuer);
}

/** CredentialAccept (subject). Returns { hash, meta }. */
export async function acceptCredential(client, subject, { issuer, credentialType }) {
  return submitAndWait(client, {
    TransactionType: "CredentialAccept",
    Account: subject.address,
    Issuer: issuer.address,
    CredentialType: credentialType,
  }, subject);
}

/**
 * Issue and accept one credential instance for `subject`. Returns
 * { createHash, acceptHash, credential } where `credential` is the accepted object.
 */
export async function issueAcceptedCredential(client, { issuer, subject, credentialType, uri, expiration }) {
  const create = await createCredential(client, issuer, { subject, credentialType, uri, expiration });
  const accept = await acceptCredential(client, subject, { issuer, credentialType });
  const credential = await readCredential(client, {
    issuer: issuer.address, subject: subject.address, credentialType,
  });
  return { createHash: create.hash, acceptHash: accept.hash, credential };
}

// ---- XLS-80 Permissioned Domains ----

/**
 * One AcceptedCredentials entry in the wrapped form xrpl.js and the ledger require:
 * { Credential: { Issuer, CredentialType } }. The flat { Issuer, CredentialType }
 * form fails validation.
 */
export const acceptedCredential = (issuer, credentialType) => ({
  Credential: { Issuer: issuer, CredentialType: credentialType },
});

/**
 * Create a permissioned domain owned by `owner` that accepts `acceptedCredentials`
 * (an AuthorizeCredential[] built with acceptedCredential). Returns
 * { hash, meta, domainId }.
 */
export async function setPermissionedDomain(client, owner, acceptedCredentials) {
  const res = await submitAndWait(client, {
    TransactionType: "PermissionedDomainSet",
    Account: owner.address,
    AcceptedCredentials: acceptedCredentials,
  }, owner);
  return { hash: res.hash, meta: res.meta, domainId: createdIndex(res.meta, "PermissionedDomain") };
}

/** Read a PermissionedDomain object by its DomainID. */
export const readPermissionedDomain = (client, domainId) => readLedgerEntry(client, domainId);
