"use client";

// Access: verification credentials that gate compliance-restricted markets. A subject
// accepts a credential from an issuer; issuers grant them. Plain language; the
// credential label is encoded for you and result codes are hidden.

import { useCallback, useState } from "react";
import { convertStringToHex } from "xrpl";
import { Header } from "../../components/Header";
import { TxButton, explain } from "../../components/lending";
import { useWallet } from "../../components/providers/WalletProvider";
import { readCredential, isAccepted } from "../../lib/access-read";
import { Card, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Button } from "../../components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { CheckCircle2 } from "lucide-react";

function Field({ id, label, value, onChange, placeholder, mono }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder={placeholder} className={mono ? "font-mono text-xs" : ""} />
    </div>
  );
}

// The credentials this app recognizes. Both the issuer and the recipient pick from
// the same list, so a typo can never make them mismatch.
const CREDENTIAL_TYPES = ["KYC verified", "Accredited investor", "Institutional"];

function CredSelect({ id, value, onChange }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Credential</Label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {CREDENTIAL_TYPES.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
    </div>
  );
}

export default function AccessPage() {
  const { walletManager, isConnected } = useWallet();
  const address = walletManager?.account?.address || null;

  const [issuer, setIssuer] = useState("");
  const [subject, setSubject] = useState("");
  const [kind, setKind] = useState("KYC verified");
  const [status, setStatus] = useState(null);

  const hex = (t) => convertStringToHex(t || "");

  const check = useCallback(async () => {
    setStatus(null);
    try {
      const c = await readCredential({ issuer, subject: address, credentialType: hex(kind) });
      setStatus(c && isAccepted(c) ? "verified" : c ? "pending" : "none");
    } catch {
      setStatus("none");
    }
  }, [issuer, address, kind]);

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <div className="container max-w-3xl py-8 space-y-6">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Verification</h1>
            <p className="mt-1 text-muted-foreground">
              Some markets are limited to verified participants. Get a credential from a trusted
              issuer and accept it to unlock them.
            </p>
          </div>

          <Card>
            <CardContent className="space-y-3 p-6">
              <h2 className="font-medium">Your status</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="iss" label="Issuer" value={issuer} onChange={setIssuer} placeholder="r… of the verifier" mono />
                <CredSelect id="kind" value={kind} onChange={setKind} />
              </div>
              <Button variant="secondary" onClick={check} disabled={!isConnected || !issuer}>Check my status</Button>
              {status === "verified" && (
                <Alert variant="success"><CheckCircle2 className="h-4 w-4" /><AlertTitle>Verified</AlertTitle><AlertDescription>You can access markets gated by this credential.</AlertDescription></Alert>
              )}
              {status === "pending" && (
                <Alert variant="warning"><AlertTitle>Awaiting your acceptance</AlertTitle><AlertDescription>The issuer granted it — accept it below to finish.</AlertDescription></Alert>
              )}
              {status === "none" && <p className="text-sm text-muted-foreground">No credential from that issuer yet.</p>}
            </CardContent>
          </Card>

          <div className="grid gap-6 sm:grid-cols-2">
            <Card>
              <CardContent className="space-y-3 p-6">
                <h2 className="font-medium">Accept a credential</h2>
                <p className="text-xs text-muted-foreground">You’re the recipient. Finish verification granted to you.</p>
                <Field id="a-iss" label="Issuer" value={issuer} onChange={setIssuer} placeholder="r…" mono />
                <CredSelect id="a-kind" value={kind} onChange={setKind} />
                <TxButton
                  label="Accept"
                  explain={explain}
                  disabled={!isConnected || !issuer}
                  tx={() => ({ TransactionType: "CredentialAccept", Account: address, Issuer: issuer, CredentialType: hex(kind) })}
                  onResult={check}
                />
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-3 p-6">
                <h2 className="font-medium">Issue a credential</h2>
                <p className="text-xs text-muted-foreground">For verifiers: grant a credential to someone.</p>
                <Field id="i-sub" label="Recipient" value={subject} onChange={setSubject} placeholder="r…" mono />
                <CredSelect id="i-kind" value={kind} onChange={setKind} />
                <TxButton
                  label="Issue"
                  variant="outline"
                  explain={explain}
                  disabled={!isConnected || !subject}
                  tx={() => ({ TransactionType: "CredentialCreate", Account: address, Subject: subject, CredentialType: hex(kind) })}
                  onResult={() => {}}
                />
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
