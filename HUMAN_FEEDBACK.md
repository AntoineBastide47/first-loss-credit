Was the relationship between vault, loan broker and loan clear from the documentation?

The objects themselves were. What wasn't documented is the ownership coupling, and it's the single most consequential thing we learned: the loan broker owner must be the vault owner, must be the LoanSet counterparty signer, and is the only account that can fund cover (anything else returns tecNO_PERMISSION). Nothing in the docs draws that line, and it means a vault created from a user's own wallet can never originate a loan. That forced the whole architecture into a custodial desk that owns every vault, broker and loan object, with the real creator recorded off-protocol in the vault's `Data field.
Also undocumented and only found by experiment: a broker's Loan objects live in a pseudo-account, which is the only way to enumerate a broker's loan book. There's no index from a broker to its loans, and no index of vaults at all, so discovery means crawling known accounts with account_objects.

Did first-loss-capital parameters behave as their names suggested?

Yes, and the core mechanic is sound. On LoanManage with tfLoanDefault, cover was liquidated into the vault and the residual became a realised vault loss, with conservation holding to within one drop.
One naming issue that did bite: tecINSUFFICIENT_FUNDS on LoanBrokerCoverWithdraw when the withdrawal would breach CoverRateMinimum. The funds exist; the ratio is what's violated. Four distinct lending guardrails collapse into that one code.

How did broker and borrower coordinate the multi-party LoanSet signature?

Badly, and it was the largest measured cost of the event: 5859 seconds to first success, two attempts, resolving a temBAD_SIGNER.
The borrower signs the LoanSet first, then the counterparty adds CounterpartySignature over the same blob using the CounterpartyTxSign prefix. Three things made it hard:
_signLoanSetByCounterparty in xrpl.js 5.1.0 signed with the wrong hash prefix, so rippled rejected an otherwise correct signature. Only fixed in 5.2.0-beta.1, which this project pins for that reason alone.
_temBAD_SIGNER reports signer duplication rather than a missing or mis-prefixed counterparty signature, which sends you looking in the wrong place.
_xrpl.js happily validates a LoanSet signing state that both devnets reject.
A second-order problem: browser wallet adapters can't produce that prefix at all, and they disagree on what sign() returns in tx_blob (Crossmark gives a real serialized blob, WalletConnect and GemWallet return a bare signature). Reassembling a counter-signable blob in the browser needed adapter-specific handling.

Did the SDK support the needed transaction types, or did you construct raw JSON?

Supported throughout. No raw JSON was needed for any XLS-65 or XLS-66 transaction, and server_definitions exposed all the experimental formats.
Where it fell short was validation fidelity rather than coverage: validateLoanSet omits the protocol minimum for GracePeriod, accepts non-positive PaymentTotal values that rippled rejects, and defers invalid UInt32 values to a fieldless codec error. Type definitions also lag the ledger: AccountObject omits the lending object types, VaultInfoResponse omits live closed-vault phase fields, and LedgerEntryRequest omits the Vault, LoanBroker, Loan and PermissionedDomain selectors that the server actually accepts. The Escrow ledger type omits Sequence, which is present on-ledger and is exactly what EscrowFinish needs as OfferSequence.

Could you read position value, utilisation, available liquidity and accrued yield without guessing?

Utilisation and available liquidity: yes, directly from AssetsTotal and AssetsAvailable.
Position value and accrued yield: no. Neither is a field."
A related sharp edge: XRPL omits zero-valued fields, so a fully repaid loan keeps PeriodicPayment and NextPaymentDueDate while dropping its balances. A naive read shows a settled loan as overdue with a payment due. A defaulted loan has the same shape, and only the flag separates them.

Did the explorer and documentation match observed ledger behaviour?

Mostly, with real exceptions:
_The XLS-66 README lists LoanPay as transaction type 83; rippled and the xrpl.js codec use 84.
_The documented lending devnet host lend.devnet.rippletest.net does not resolve.
_XLS-0085 lists exactly three causes of tecNO_PERMISSION for an MPT escrow (source is the issuer, missing lsfMPTCanEscrow, missing lsfMPTCanTransfer). It omits permissioned-domain membership of the destination, which cost about 40 minutes because every listed cause checked out fine.
_LoanBrokerSet documents the wrong lower bound for ManagementFeeRate.
_Closed-ended vault and cash-basis loan specs live only in unmerged PRs, not master XLS-65/66.
_No documented programmatic faucet for the event devnet, and the two devnet faucets return incompatible response shapes.
Worth adding to any writeup: tecNO_PERMISSION carried at least six distinct meanings across this build, which makes it the least informative code we met. By contrast tecINSUFFICIENT_PAYMENT on LoanPay and tecHAS_OBLIGATIONS on VaultDelete were genuinely specific and pointed straight at the cause.
And dev wallet was a pain to use due to needing to relog in on each page refresh