"use client";

// Reads for XLS-70 Credentials and XLS-80 Permissioned Domains.

import { getClient } from "./xrpl-client";

export const LSF_CREDENTIAL_ACCEPTED = 0x00010000;

export const isAccepted = (cred) => (Number(cred?.Flags ?? 0) & LSF_CREDENTIAL_ACCEPTED) !== 0;

export async function readCredential({ issuer, subject, credentialType }) {
  const client = await getClient();
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

export async function readPermissionedDomain(domainId) {
  const client = await getClient();
  try {
    const { result } = await client.request({ command: "ledger_entry", index: domainId, ledger_index: "validated" });
    return result.node;
  } catch (e) {
    if (e?.data?.error === "entryNotFound") return null;
    throw e;
  }
}

export const acceptedCredential = (issuer, credentialType) => ({
  Credential: { Issuer: issuer, CredentialType: credentialType },
});

export function domainAccepts(domain, issuer, credentialType) {
  return (domain?.AcceptedCredentials || []).some(
    (e) => e.Credential?.Issuer === issuer && e.Credential?.CredentialType === credentialType,
  );
}
