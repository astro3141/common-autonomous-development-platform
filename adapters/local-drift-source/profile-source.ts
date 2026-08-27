/**
 * DocumentProfileSource — the file-backed `ProfileSource` (TD §11.4, M1-11).
 *
 * The Profile Compiler is pure by contract and `core/profile` may not touch a filesystem, so the
 * *current* Profile and Policy have to be read from somewhere outside it. That is all this is:
 * read the configured document, run it through the existing Core validators, and derive the same
 * component ref the Compiled Profile carries — `{id, version, hash}` over the same schema
 * envelope, so a ref from here is directly comparable with a frozen one.
 *
 * There is no cache, no watch and no projection: every call re-reads and re-validates, so two
 * calls in the same pass cannot disagree with each other. A document that cannot be read or does
 * not validate throws; the caller turns that into `UNAVAILABLE` rather than into "no drift".
 */

import { readFileSync } from "node:fs";

import { hashEnvelope, makeEnvelope } from "../../core/schemas/envelope.ts";
import type { CanonicalObject } from "../../core/schemas/canonical-json.ts";
import { validateExecutionPolicy } from "../../core/profile/validate-execution-policy.ts";
import { validateProjectProfile } from "../../core/profile/validate-project-profile.ts";
import {
  EXECUTION_POLICY_SCHEMA,
  PROJECT_PROFILE_SCHEMA,
  type ExecutionPolicyV1Body,
  type ProfileComponentRead,
  type ProfileSource,
  type ProjectProfileV1Body,
} from "../../core/profile/types.ts";

export interface ProfileDocuments {
  readonly project_profile_path: string;
  readonly execution_policy_path: string;
}

/** Injectable so a test needs no filesystem — the same seam `ProjectDocumentTaskSource` uses. */
export type ProfileDocumentReader = (path: string) => string;

const defaultReader: ProfileDocumentReader = (path) => readFileSync(path, "utf8");

export class DocumentProfileSource implements ProfileSource {
  readonly #documents: ProfileDocuments;
  readonly #read: ProfileDocumentReader;

  constructor(documents: ProfileDocuments, reader: ProfileDocumentReader = defaultReader) {
    this.#documents = documents;
    this.#read = reader;
  }

  current_project_profile(): ProfileComponentRead<ProjectProfileV1Body> {
    const body = validateProjectProfile(this.#parse(this.#documents.project_profile_path));
    return { ref: componentRef(PROJECT_PROFILE_SCHEMA, body), body };
  }

  current_execution_policy(): ProfileComponentRead<ExecutionPolicyV1Body> {
    const body = validateExecutionPolicy(this.#parse(this.#documents.execution_policy_path));
    return { ref: componentRef(EXECUTION_POLICY_SCHEMA, body), body };
  }

  #parse(path: string): unknown {
    return JSON.parse(this.#read(path)) as unknown;
  }
}

/** Exactly how the Compiled Profile derives its own refs, so the two are comparable. */
function componentRef(
  schema: string,
  body: { readonly id: string; readonly version: number },
): { id: string; version: number; hash: string } {
  return {
    id: body.id,
    version: body.version,
    hash: hashEnvelope(makeEnvelope(schema, 1, body as unknown as CanonicalObject)),
  };
}
