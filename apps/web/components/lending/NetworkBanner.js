"use client";

import { useEffect, useState } from "react";
import { missingAmendments } from "../../lib/xrpl-client";
import { DEFAULT_NETWORK } from "../../lib/networks";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { AlertTriangle, XCircle } from "lucide-react";

// Checks the connected devnet for the lending amendments once and warns if the
// flow is unsupported or the network is unreachable. Renders nothing when ready.
export function NetworkBanner() {
  const [state, setState] = useState({ status: "checking" });

  useEffect(() => {
    let active = true;
    missingAmendments()
      .then((missing) => active && setState({ status: missing.length ? "missing" : "ok", missing }))
      .catch((err) => active && setState({ status: "error", message: err.message }));
    return () => {
      active = false;
    };
  }, []);

  if (state.status === "ok" || state.status === "checking") return null;

  if (state.status === "error") {
    return (
      <Alert variant="destructive">
        <XCircle className="h-4 w-4" />
        <AlertTitle>Cannot reach {DEFAULT_NETWORK.name}</AlertTitle>
        <AlertDescription className="break-all">{state.message}</AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="warning">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Lending protocol not enabled</AlertTitle>
      <AlertDescription>
        {DEFAULT_NETWORK.name} is missing required amendments: {state.missing.join(", ")}.
      </AlertDescription>
    </Alert>
  );
}
