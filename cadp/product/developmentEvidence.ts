/** Evidence carried unchanged into both PR_CREATE and PR_MERGE admission inputs. */
export function developmentEvidenceRefs(input: {
  verification_evidence_id: string;
  review_evidence_id: string;
  worker_backend_evidence_id: string;
  reviewer_backend_evidence_id: string;
  work_step_envelope_id: string;
  external_verification_evidence_id?: string;
}): string[] {
  return [
    input.verification_evidence_id,
    input.review_evidence_id,
    input.worker_backend_evidence_id,
    input.reviewer_backend_evidence_id,
    input.work_step_envelope_id,
    ...(input.external_verification_evidence_id === undefined ? [] : [input.external_verification_evidence_id]),
  ];
}
