import type { ErrorCode } from "@dnp/contract";
import type { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { TransactionCanceledException as TCE } from "@aws-sdk/client-dynamodb";
import { TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

export interface CancellationReason {
  /** Caller-supplied label of the transaction item at this index. */
  label: string;
  /** DynamoDB reason code: ConditionalCheckFailed, TransactionConflict, ValidationError, ... */
  code: string;
  message?: string;
  /** Existing item (ReturnValuesOnConditionCheckFailure: ALL_OLD), if any. */
  item?: Record<string, unknown>;
}

/** A transaction was cancelled; `reasons` lists only the items that did not succeed. */
export class TransactionConflictError extends Error {
  readonly reasons: CancellationReason[];
  constructor(reasons: CancellationReason[], cause?: unknown) {
    super(`Transaction cancelled: ${reasons.map((r) => `${r.label}(${r.code})`).join(", ")}`, {
      cause,
    });
    this.name = "TransactionConflictError";
    this.reasons = reasons;
  }
  get labels(): string[] {
    return this.reasons.map((r) => r.label);
  }
  has(label: string): boolean {
    return this.reasons.some((r) => r.label === label);
  }
}

export type TransactItems = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]
>;

/**
 * Runs TransactWriteItems. `labels[i]` names `items[i]`; on cancellation the failing items are
 * reported by label so callers can map them to 409 reasons.
 */
export async function transactWrite(
  doc: DynamoDBDocumentClient,
  items: TransactItems,
  labels: string[],
): Promise<void> {
  if (items.length !== labels.length)
    throw new Error("transactWrite: items/labels length mismatch");
  const withReturn = items.map((item) => {
    const out = { ...item };
    for (const op of ["Put", "Update", "Delete", "ConditionCheck"] as const) {
      const v = out[op];
      if (v)
        (out as Record<string, unknown>)[op] = {
          ...v,
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        };
    }
    return out;
  });
  try {
    await doc.send(new TransactWriteCommand({ TransactItems: withReturn }));
  } catch (err) {
    if (err instanceof TCE || (err as { name?: string })?.name === "TransactionCanceledException") {
      const reasons = (err as TransactionCanceledException).CancellationReasons ?? [];
      const mapped: CancellationReason[] = [];
      reasons.forEach((r, i) => {
        if (!r || r.Code === "None" || r.Code === undefined) return;
        mapped.push({
          label: labels[i] ?? `item${i}`,
          code: r.Code,
          message: r.Message,
          item: r.Item ? unmarshall(r.Item) : undefined,
        });
      });
      throw new TransactionConflictError(mapped, err);
    }
    throw err;
  }
}

/** A business-rule failure the API maps to an HTTP status (codes are @dnp/contract ErrorCode). */
export class DomainError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message?: string) {
    super(message ?? code);
    this.name = "DomainError";
    this.code = code;
  }
}
