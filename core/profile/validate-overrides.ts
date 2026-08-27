/**
 * ApprovedOverridesV1 validation (TD §7.1c).
 *
 * Shape only — privilege direction and approval binding are decided during compilation, where the
 * current effective value is known.
 */

import { ProfileCompileError, schemaError } from "./errors.ts";
import { asArray, asNonEmptyString, asObject, exactKeys } from "./shape.ts";
import { isOverridePath, OVERRIDE_WHITELIST, typeOverrideValue } from "./override-policy.ts";
import { sortByFieldPath } from "./semantic-set.ts";
import type { ApprovedOverride, ApprovedOverridesV1Body } from "./types.ts";

export function validateApprovedOverrides(input: unknown): ApprovedOverridesV1Body {
  const body = asObject(input, "");
  exactKeys(body, "", ["items"]);

  const entries = asArray(body["items"], "/items");
  const items: ApprovedOverride[] = entries.map((entry, index) => {
    const path = `/items/${index}`;
    const object = asObject(entry, path);

    for (const key of Object.keys(object)) {
      if (!["field_path", "value", "approval_ref", "approval_hash"].includes(key)) {
        throw schemaError(path, `unknown field "${key}"`);
      }
    }
    if (!Object.hasOwn(object, "field_path")) {
      throw schemaError(path, 'missing required field "field_path"');
    }
    if (!Object.hasOwn(object, "value")) {
      throw schemaError(path, 'missing required field "value"');
    }

    const fieldPath = asNonEmptyString(object["field_path"], `${path}/field_path`);
    if (!isOverridePath(fieldPath)) {
      // Project Profile paths and anything outside the closed v1 list land here.
      throw new ProfileCompileError(
        "OVERRIDE_NOT_ALLOWED",
        `${path}/field_path`,
        `${JSON.stringify(fieldPath)} is not an overridable field; allowed: ${OVERRIDE_WHITELIST.join(", ")}`,
      );
    }

    const override: ApprovedOverride = {
      field_path: fieldPath,
      // Typed and normalized against the field's domain here, so the *hashed* body already
      // carries the canonical form of a semantic-set value (§7.2 rule 6, M0-13).
      value: typeOverrideValue(fieldPath, object["value"]) as ApprovedOverride["value"],
      ...(Object.hasOwn(object, "approval_ref")
        ? { approval_ref: asNonEmptyString(object["approval_ref"], `${path}/approval_ref`) }
        : {}),
      ...(Object.hasOwn(object, "approval_hash")
        ? { approval_hash: asNonEmptyString(object["approval_hash"], `${path}/approval_hash`) }
        : {}),
    };
    return override;
  });

  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (seen.has(item.field_path)) {
      throw new ProfileCompileError(
        "DUPLICATE",
        `/items/${index}/field_path`,
        `duplicate override field_path: ${item.field_path}`,
      );
    }
    seen.add(item.field_path);
  }

  // Semantic set (§7.1c M0-13): canonical order is field_path code-point ascending.
  return { items: sortByFieldPath(items) };
}
