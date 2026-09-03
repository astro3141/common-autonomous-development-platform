/**
 * Live TemporalTransport over the Temporal TS SDK (Server 1.31 semantics, TD §6.4):
 * REJECT_DUPLICATE reuse policy + FAIL conflict policy; Describe is persistence-backed and
 * returns the decoded target-side memo.
 */

import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";

import type { TemporalTransport } from "./temporal.ts";

export class LiveTemporalTransport implements TemporalTransport {
  #client: Client | undefined;
  readonly address: string;
  readonly namespace: string;

  constructor(address: string, namespace: string) {
    this.address = address;
    this.namespace = namespace;
  }

  async #getClient(): Promise<Client> {
    if (this.#client === undefined) {
      const connection = await Connection.connect({ address: this.address });
      this.#client = new Client({ connection, namespace: this.namespace });
    }
    return this.#client;
  }

  async describeNamespace(): Promise<{ namespace_id: string; retention_s: number }> {
    const client = await this.#getClient();
    const res = await client.connection.workflowService.describeNamespace({ namespace: this.namespace });
    const retention = res.config?.workflowExecutionRetentionTtl?.seconds;
    return {
      namespace_id: res.namespaceInfo?.id ?? this.namespace,
      retention_s: retention !== undefined && retention !== null ? Number(retention) : 0,
    };
  }

  async start(input: {
    workflow_id: string;
    workflow_type: string;
    task_queue: string;
    args: unknown[];
    memo: Record<string, unknown>;
  }): Promise<
    | { kind: "started"; run_id: string }
    | { kind: "already_started"; run_id?: string }
    | { kind: "rejected"; grpc_status: string; detail: string }
    | { kind: "ambiguous"; detail: string }
  > {
    const client = await this.#getClient();
    try {
      const handle = await client.workflow.start(input.workflow_type, {
        workflowId: input.workflow_id,
        taskQueue: input.task_queue,
        args: input.args,
        memo: input.memo,
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        workflowIdConflictPolicy: "FAIL",
      });
      return { kind: "started", run_id: handle.firstExecutionRunId };
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) {
        return { kind: "already_started" };
      }
      const grpc = (error as { code?: number }).code;
      const message = error instanceof Error ? error.message : String(error);
      // gRPC: 3 INVALID_ARGUMENT, 5 NOT_FOUND, 7 PERMISSION_DENIED → service rejected pre-effect.
      if (grpc === 3 || grpc === 5 || grpc === 7) {
        return { kind: "rejected", grpc_status: String(grpc), detail: message.slice(0, 300) };
      }
      return { kind: "ambiguous", detail: message.slice(0, 300) };
    }
  }

  async describe(workflow_id: string, run_id?: string): Promise<
    | { kind: "found"; run_id: string; memo: Record<string, unknown>; status: string }
    | { kind: "not_found" }
    | { kind: "ambiguous"; detail: string }
  > {
    const client = await this.#getClient();
    try {
      const handle = client.workflow.getHandle(workflow_id, run_id);
      const description = await handle.describe();
      return {
        kind: "found",
        run_id: description.runId,
        memo: (description.memo ?? {}) as Record<string, unknown>,
        status: description.status.name,
      };
    } catch (error) {
      const grpc = (error as { code?: number; cause?: { code?: number } }).code ?? (error as { cause?: { code?: number } }).cause?.code;
      if (grpc === 5) return { kind: "not_found" };
      if (error instanceof Error && /not found/iu.test(error.message)) return { kind: "not_found" };
      return { kind: "ambiguous", detail: error instanceof Error ? error.message.slice(0, 300) : String(error) };
    }
  }
}
