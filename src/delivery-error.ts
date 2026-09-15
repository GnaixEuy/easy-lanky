// Only trusted transport classifications may turn an uncertain send into a
// definite failure. Never copy raw SDK errors (which can contain credentials).
export class DeliveryError extends Error {
  constructor(
    readonly outcome: "failed" | "unknown",
    readonly reason: string,
    readonly providerCode?: number,
    readonly userMessage?: string,
  ) {
    super(reason);
  }
}
