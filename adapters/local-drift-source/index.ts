/**
 * The two M1-11 read seams, file-backed (TD §11.4).
 *
 * They are authorities, not a framework: each answers exactly the question its Core interface
 * declares, owns the filesystem access Core is not allowed to have, and holds no state.
 */

export {
  DocumentProfileSource,
  type ProfileDocumentReader,
  type ProfileDocuments,
} from "./profile-source.ts";
export {
  FileContractSourceReader,
  type ContractSourceBytesReader,
} from "./contract-source-reader.ts";
