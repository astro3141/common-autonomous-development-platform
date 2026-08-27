/**
 * LocalGit — the production RepositoryAdapter implementation (TD §14.3).
 *
 * A primitive surface only: nothing here is wired into the Coordinator, and the Repository Gate
 * that would be allowed to call `commit_merge` does not exist yet.
 */

export {
  LocalGitRepositoryAdapter,
  LOCAL_GIT_CONFIG_FIELDS,
  RepositoryConfigError,
  validateLocalGitRepositoryConfig,
  type LocalGitRepositoryConfig,
} from "./local-git-repository-adapter.ts";
export { GitError } from "./git.ts";
