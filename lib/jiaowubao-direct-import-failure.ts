const CUSTOM_ERROR_PREFIX = "jiaowubao_direct_import_";
const CUSTOM_ERROR_PATTERN = /^jiaowubao_direct_import_[a-z0-9_]+$/u;
// Accept only terminal semantics used by the import's deliberately raised,
// disclosure-safe error messages. PostgreSQL verbose diagnostics can quote
// private relation/function identifiers such as
// `internal.jiaowubao_direct_import_chunks`; an arbitrary prefix match would
// let those identifiers mask the real SQLSTATE or a client-side timeout.
const CUSTOM_ERROR_TERMINAL_PATTERN = /_(?:invalid|mismatch|ambiguous|unavailable|changed|unknown|forbidden|required|incomplete|conflict|exceeded|missing|not_found|not_staging|read_only|must_start_staging|unresolved|not_yet_authoritative|duplicate_identity_proof|duplicate_source_key|sequence_gap|not_current_tencent_record|not_exact_current_record|invalid_transition|changed_operational_state)$/u;
const SQLSTATE_PREFIX = "sqlstate";
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/u;
const VERBOSE_ERROR_PREFIX = "error";
const MAX_CUSTOM_ERROR_LENGTH = 160;
const MAX_SQLSTATE_SEPARATOR_LENGTH = 24;
const INTERNAL_FUNCTION_TOKEN = /^jiaowubao_direct_import_(?:assert_[a-z0-9_]+|[a-z0-9_]+_guard|chunk|payload_sha256|validate_projection)$/u;

export type JiaowubaoDirectImportDbFailureCategory =
  | `jiaowubao_direct_import_${string}`
  | `database_sqlstate_${string}`
  | "database_timeout"
  | "database_failure";

/**
 * Streaming, disclosure-safe classifier for database stderr.
 *
 * The classifier deliberately never stores a stderr chunk, a source line, or
 * an arbitrary substring. It recognises only our fixed custom error prefix
 * and PostgreSQL's `SQLSTATE XXXXX` marker one character at a time. This lets
 * the production writer report an actionable category without retaining or
 * echoing a diagnostic that could quote Excel evidence.
 */
export class JiaowubaoDirectImportDbFailureClassifier {
  private customPrefixIndex = 0;
  private customCandidate = "";
  private customError: `jiaowubao_direct_import_${string}` | undefined;
  private sqlstatePrefixIndex = 0;
  private sqlstateMode: "prefix" | "separator" | "code" | "boundary" = "prefix";
  private sqlstateSeparatorLength = 0;
  private sqlstateCandidate = "";
  private sqlstate: string | undefined;
  private verbosePrefixIndex = 0;
  private verboseMode: "prefix" | "separator" | "code" | "boundary" = "prefix";
  private verboseSeparatorLength = 0;
  private verboseCandidate = "";
  private verboseSqlstate: string | undefined;
  private timedOut = false;

  feed(value: Uint8Array | string) {
    const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
    for (const character of text) {
      this.feedCustomError(character);
      this.feedSqlstate(character);
      this.feedVerboseSqlstate(character);
    }
  }

  markTimeout() {
    this.timedOut = true;
  }

  category(): JiaowubaoDirectImportDbFailureCategory {
    this.finishCustomCandidate();
    this.finishSqlstateCandidate();
    this.finishVerboseCandidate();
    if (this.customError) return this.customError;
    if (this.timedOut) return "database_timeout";
    if (this.sqlstate) return `database_sqlstate_${this.sqlstate}`;
    if (this.verboseSqlstate) return `database_sqlstate_${this.verboseSqlstate}`;
    return "database_failure";
  }

  private feedCustomError(character: string) {
    if (this.customError) return;
    if (this.customCandidate) {
      if (/^[a-z0-9_]$/u.test(character)
        && this.customCandidate.length < MAX_CUSTOM_ERROR_LENGTH) {
        this.customCandidate += character;
        return;
      }
      this.finishCustomCandidate();
      this.customPrefixIndex = character === CUSTOM_ERROR_PREFIX[0] ? 1 : 0;
      return;
    }

    const expected = CUSTOM_ERROR_PREFIX[this.customPrefixIndex];
    if (character === expected) {
      this.customPrefixIndex += 1;
      if (this.customPrefixIndex === CUSTOM_ERROR_PREFIX.length) {
        this.customCandidate = CUSTOM_ERROR_PREFIX;
        this.customPrefixIndex = 0;
      }
      return;
    }
    this.customPrefixIndex = character === CUSTOM_ERROR_PREFIX[0] ? 1 : 0;
  }

  private finishCustomCandidate() {
    if (CUSTOM_ERROR_PATTERN.test(this.customCandidate)
      && this.customCandidate.length > CUSTOM_ERROR_PREFIX.length
      && CUSTOM_ERROR_TERMINAL_PATTERN.test(this.customCandidate)
      // PostgreSQL CONTEXT lines include private helper function names. They
      // are not error categories and previously masked the real SQLSTATE for
      // generic engine errors such as an operator/type failure.
      && !INTERNAL_FUNCTION_TOKEN.test(this.customCandidate)) {
      this.customError = this.customCandidate as `jiaowubao_direct_import_${string}`;
    }
    this.customCandidate = "";
  }

  private feedSqlstate(character: string) {
    if (this.sqlstate) return;
    const lower = character.toLowerCase();

    if (this.sqlstateMode === "prefix") {
      const expected = SQLSTATE_PREFIX[this.sqlstatePrefixIndex];
      if (lower === expected) {
        this.sqlstatePrefixIndex += 1;
        if (this.sqlstatePrefixIndex === SQLSTATE_PREFIX.length) {
          this.sqlstateMode = "separator";
          this.sqlstatePrefixIndex = 0;
          this.sqlstateSeparatorLength = 0;
        }
      } else {
        this.sqlstatePrefixIndex = lower === SQLSTATE_PREFIX[0] ? 1 : 0;
      }
      return;
    }

    if (this.sqlstateMode === "separator") {
      if (/^[\s:=()[\]{},-]$/u.test(character)
        && this.sqlstateSeparatorLength < MAX_SQLSTATE_SEPARATOR_LENGTH) {
        this.sqlstateSeparatorLength += 1;
        return;
      }
      if (/^[0-9A-Za-z]$/u.test(character)) {
        this.sqlstateCandidate = character.toUpperCase();
        this.sqlstateMode = "code";
        return;
      }
      this.resetSqlstate(character);
      return;
    }

    if (this.sqlstateMode === "code") {
      if (/^[0-9A-Za-z]$/u.test(character)) {
        this.sqlstateCandidate += character.toUpperCase();
        if (this.sqlstateCandidate.length === 5) this.sqlstateMode = "boundary";
        return;
      }
      this.resetSqlstate(character);
      return;
    }

    if (/^[0-9A-Za-z]$/u.test(character)) {
      this.resetSqlstate(character);
      return;
    }
    this.finishSqlstateCandidate();
  }

  private finishSqlstateCandidate() {
    if (this.sqlstateMode === "boundary" && SQLSTATE_PATTERN.test(this.sqlstateCandidate)) {
      this.sqlstate = this.sqlstateCandidate;
    }
    this.sqlstateCandidate = "";
    if (!this.sqlstate) this.sqlstateMode = "prefix";
  }

  private resetSqlstate(character: string) {
    this.sqlstateMode = "prefix";
    this.sqlstatePrefixIndex = character.toLowerCase() === SQLSTATE_PREFIX[0] ? 1 : 0;
    this.sqlstateSeparatorLength = 0;
    this.sqlstateCandidate = "";
  }

  /** PostgreSQL's psql `VERBOSITY verbose` renders `ERROR:  22023: ...`. */
  private feedVerboseSqlstate(character: string) {
    if (this.verboseSqlstate) return;
    const lower = character.toLowerCase();
    if (this.verboseMode === "prefix") {
      const expected = VERBOSE_ERROR_PREFIX[this.verbosePrefixIndex];
      if (lower === expected) {
        this.verbosePrefixIndex += 1;
        if (this.verbosePrefixIndex === VERBOSE_ERROR_PREFIX.length) {
          this.verboseMode = "separator";
          this.verbosePrefixIndex = 0;
          this.verboseSeparatorLength = 0;
        }
      } else {
        this.verbosePrefixIndex = lower === VERBOSE_ERROR_PREFIX[0] ? 1 : 0;
      }
      return;
    }
    if (this.verboseMode === "separator") {
      if (/^[\s:]$/u.test(character) && this.verboseSeparatorLength < 24) {
        this.verboseSeparatorLength += 1;
        return;
      }
      if (/^[0-9A-Za-z]$/u.test(character)) {
        this.verboseCandidate = character.toUpperCase();
        this.verboseMode = "code";
        return;
      }
      this.resetVerboseSqlstate(character);
      return;
    }
    if (this.verboseMode === "code") {
      if (/^[0-9A-Za-z]$/u.test(character)) {
        this.verboseCandidate += character.toUpperCase();
        if (this.verboseCandidate.length === 5) this.verboseMode = "boundary";
        return;
      }
      this.resetVerboseSqlstate(character);
      return;
    }
    if (/^[0-9A-Za-z]$/u.test(character)) {
      this.resetVerboseSqlstate(character);
      return;
    }
    this.finishVerboseCandidate();
  }

  private finishVerboseCandidate() {
    if (this.verboseMode === "boundary" && SQLSTATE_PATTERN.test(this.verboseCandidate)) {
      this.verboseSqlstate = this.verboseCandidate;
    }
    this.verboseCandidate = "";
    if (!this.verboseSqlstate) this.verboseMode = "prefix";
  }

  private resetVerboseSqlstate(character: string) {
    this.verboseMode = "prefix";
    this.verbosePrefixIndex = character.toLowerCase() === VERBOSE_ERROR_PREFIX[0] ? 1 : 0;
    this.verboseSeparatorLength = 0;
    this.verboseCandidate = "";
  }
}
