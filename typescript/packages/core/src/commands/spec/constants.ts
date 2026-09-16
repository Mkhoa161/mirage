// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

// Stand-in name for a required operand whose slot declares none, so a
// refusal that has to name the slot always has a word for it. Bare like
// every operand name: the brackets are the renderer's.
export const ARG_PLACEHOLDER = 'ARG'

const AMBIGUOUS_NAMES: Readonly<Record<string, string>> = Object.freeze({
  l: 'args_l',
  O: 'args_O',
  I: 'args_I',
  '1': 'args_1',
})

// Numeric shorthand token like `-5` (head/tail count), never a flag
// cluster or a path.
/**
 * Map a flag name to its dispatcher kwarg name.
 *
 * Mirrors Python's `flag_kwarg_name`. The dispatcher spells flags without
 * their dashes and with dashes turned into underscores, so this is the one
 * place that translation lives.
 */
export function flagKwargName(flag: string): string {
  const clean = flag.replace(/^-+/, '').replaceAll('-', '_')
  return AMBIGUOUS_NAMES[clean] ?? clean
}

export const NUMERIC_SHORT = /^-\d+$/

// GNU echo is not getopt, so its option surface is a word shape, not a
// CommandSpec: options are LEADING words matching this pattern only.
export const ECHO_OPTION = /^-[neE]+$/

// The programs with NO long-option parser at all: their answer to a
// dash-leading word they do not recognize is to print it as an operand rather
// than to refuse it, and they never expand an abbreviation. bash's `echo`
// builtin reads only a leading `-neE` cluster and prints every other word
// verbatim, `--` included (`echo -- --zzz` prints `-- --zzz`); Info-ZIP unzip
// has no `--long` grammar either, scanning the word's letters instead, so
// `unzip --nothelp` prints help for the `h` the word happens to contain.
// unzip's own refusal -- exit 10 with the whole usage block, and `--` not an
// end-of-options marker -- is a separate change; it sits here because of the
// two answers the parser has today, the lenient one is the closer.
//
// MEASURED against coreutils 9.4, bash 5.2.21 and Info-ZIP 6.00, and
// deliberately NOT derived. #1107 proposed deriving it -- require that "the
// command declare no long options" -- and no predicate over the declarations
// can work: `sleep`, `pwd`, `bc`, `history` and `printf` declare zero long
// options in mirage's specs and all five REPORT an option they do not know,
// while `echo` declares zero and treats it as an operand, so `expr` and
// `sleep` are indistinguishable that way. The `@command` decorator also
// injects `--help`/`--version` into every registered spec, so no spec declares
// zero by the time the parser reads it. Ten of the thirteen commands the old
// rest-operand-kind predicate reached (basename, dirname, csplit, numfmt,
// sleep, pwd, bc, history, bash, printf) are strict, which is why this is an
// exception list and not a rule.
export const NO_LONG_OPTIONS: ReadonlySet<string> = new Set(['echo', 'unzip'])

// The programs whose long options are parsed ONLY when the line carries
// exactly one argument: gnulib's `parse_long_options`, whose guard is
// literally `argc == 2`. Measured on coreutils 9.4: `expr --help` exits 0 with
// help, `expr --help x` exits 2 with
// `expr: syntax error: unexpected argument 'x'`, and `expr -- --help` is argc
// 3, so it prints `--help`. Inside the window getopt_long's name-prefix
// matching applies (`--h`, `--hel` and `--versio` all resolve) and a word that
// prefixes nothing falls through to an operand with no diagnostic at all,
// because parse_long_options sets `opterr = 0`: `expr --hex` prints `--hex`,
// and so does `expr --help=x`. This is a narrower rule than NO_LONG_OPTIONS
// and not the same one -- echo has no long options in any position, expr has
// them in exactly one -- so the two are spelled separately rather than
// collapsed.
export const SOLE_ARGUMENT_LONG_OPTIONS: ReadonlySet<string> = new Set(['expr'])

// The declared `choices` sets that are NOT gnulib ARGMATCH tables, so an
// abbreviation of a candidate is not a match. CPython compares
// `--check-hash-based-pycs` against its three words by hand and refuses
// anything else: measured on 3.11.15, `--check-hash-based-pycs a` and
// `--check-hash-based-pycs al` are both `--check-hash-based-pycs must be one
// of 'default', 'always', or 'never'`, where gnulib would have resolved `a` to
// `always`. Keyed by canonical long spelling, and an exception list again --
// `tee --output-error` is real argmatch and keeps its prefixes.
export const EXACT_CHOICE_OPTIONS: ReadonlySet<string> = new Set(['--check-hash-based-pycs'])

// Value shape accepted by an int-typed option: optional sign plus digits,
// the portable core of Python int() and argparse (no whitespace, no
// underscores, so both languages accept exactly the same strings).
export const INT_VALUE = /^[+-]?\d+$/
export const FLOAT_VALUE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/

// GNU usage-error exit codes, pinned against debian coreutils/grep/diffutils
// (plus ripgrep and jq upstream docs). Everything else exits 1.
// Commands whose `Try '--help'` hint line is prefixed with the command
// name (GNU diffutils style: `diff: Try 'diff --help' ...`).
export const USAGE_HINT_PREFIX: ReadonlySet<string> = new Set(['diff', 'cmp'])

// An old-style cluster letter left without its argument exits 2, not
// USAGE_EXIT's 64: tar reads the cluster itself and raises its own fatal
// error, while 64 (EX_USAGE) is what argp returns for a letter it does
// not know. Pinned on GNU tar 1.35: `tar xzf` is 2, `tar -Q` is 64.
export const OLD_OPTION_EXIT = 2

// The exit code of a command refused on one operand before it ran (an
// admission policy's operand-scoped Deny): 1 for the GNU tools, which
// report an operand they cannot act on and exit 1, and tar's own fatal
// code, since tar reports an operand it cannot open and exits 2 (GNU tar
// 1.35, `Exiting with failure status due to previous errors`).
export const OPERAND_EXIT: Readonly<Record<string, number>> = Object.freeze({
  tar: 2,
})

export const USAGE_EXIT: Readonly<Record<string, number>> = Object.freeze({
  grep: 2,
  egrep: 2,
  fgrep: 2,
  zgrep: 2,
  rg: 2,
  ls: 2,
  sort: 2,
  diff: 2,
  cmp: 2,
  awk: 2,
  jq: 2,
  curl: 2,
  tar: 64,
  python: 2,
  python3: 2,
})

// The exit code a command answers when it cannot read an operand. GNU's
// code belongs to the COMMAND, not to the errno: `sort nope` and `sort
// dir` are both 2, `cat` is 1 for both. Absent means 1, which is what
// the executor's catch-all already did on its own. Pinned on
// debian:stable-slim (coreutils 9.7, GNU sed 4.9, gzip 1.13, jq 1.7,
// binutils 2.44, util-linux 2.41.5, bsdmainutils 12.1.8, xxd from
// vim-common). The python twin is READ_FAIL_EXIT in
// commands/spec/constants.py.
export const READ_FAIL_EXIT: Readonly<Record<string, number>> = Object.freeze({
  sort: 2,
  awk: 2,
  jq: 2,
  xxd: 2,
  grep: 2,
  egrep: 2,
  fgrep: 2,
  rg: 2,
  cmp: 2,
  diff: 2,
  sed: 2,
  zgrep: 2,
  unzip: 9,
})

// The four commands whose code DOES depend on the errno, so the table
// above cannot express them on its own. sed opens the directory
// successfully and fails on the read, which is its own class (4), while a
// missing file fails at open (2). The gzip family reports a directory as
// a warning (2) and a missing file as an error (1). zgrep inverts that,
// because its exit code is grep's: a directory it cannot decompress
// yields no match (1) where a missing file is grep's own error (2).
export const READ_FAIL_EXIT_ISDIR: Readonly<Record<string, number>> = Object.freeze({
  sed: 4,
  gzip: 2,
  gunzip: 2,
  zcat: 2,
  zgrep: 1,
})

// The interpreter commands answer option errors in CPython's words, not
// GNU's: python3 is not a GNU tool, and its refusal names the
// source-selecting options a reader needs.
export const PYTHON_NAMES: ReadonlySet<string> = new Set(['python', 'python3'])

// Pinned on CPython 3.12.13, including two quirks worth keeping: the
// hint always spells the program `python` (never `python3`, whichever
// way it was invoked), and it quotes with a backquote/quote pair.
export function pythonUsage(name: string): string {
  return (
    `usage: ${name} [option] ... [-c cmd | -m mod | file | -] [arg] ...\n` +
    "Try `python -h' for more information.\n"
  )
}
