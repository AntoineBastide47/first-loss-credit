// The single lending market this product operates on. Users never see or paste these
// ids — the app deposits into this vault and originates loans against this broker.
export const MARKET = {
  name: "First-Loss Credit Vault",
  vaultId: "85B73475255A53220913778E3E4F2CA2A977FD8128426BAA43C357F52FB9EF0F",
  shareMptId: "00000001983825300F9EAD15056FF4FBEDA3AE841A0515AF",
  brokerId: "23CB91C3A0286605328E7C9550DFB903D8B8A1B9087120DF371A776E2C8E1EE9",
  operator: "rNEBeRwhfnAP5JczQbT2mxnNAY1gYmPUVT",
  seedLoanId: "8638619C7EF6FBF2D6822703F1DE97E67EC539568F7F607590E6240B9ED4B159",
  // The one loan product the desk originates. The borrow form autofills these and the
  // server rejects any co-sign whose terms differ, so only PrincipalRequested varies.
  loanTerms: { InterestRate: 100000, PaymentInterval: 3600, PaymentTotal: 6, GracePeriod: 600 },
};
