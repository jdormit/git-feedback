#!/bin/sh
# Run fdbk's ERT tests in a fresh batch Emacs with a throwaway HOME.
# Usage: emacs/run-tests.sh [SELECTOR-REGEXP]
# Set FDBK_DEPS to a directory of package directories (default: straight's build dir).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
deps=${FDBK_DEPS:-$HOME/.emacs.d/straight/build}
emacs=${EMACS:-emacs}
# Resolve before HOME changes; version-manager shims depend on it.
FDBK_TEST_BUN=$(command -v bun)
if command -v mise >/dev/null 2>&1; then FDBK_TEST_BUN=$(mise which bun 2>/dev/null || echo "$FDBK_TEST_BUN"); fi
export FDBK_TEST_BUN
sandbox=$(mktemp -d "${TMPDIR:-/tmp}/fdbk-el-home.XXXXXX")
trap 'rm -rf "$sandbox"' EXIT

load_path=""
for pkg in compat cond-let dash llama seq transient with-editor magit-section magit markdown-mode goto-chg evil; do
  [ -d "$deps/$pkg" ] && load_path="$load_path -L $deps/$pkg"
done

cd "$sandbox"
# shellcheck disable=SC2086
HOME="$sandbox" "$emacs" -Q --batch $load_path -L "$here" \
  --eval '(setq byte-compile-error-on-warn t)' \
  -f batch-byte-compile "$here/fdbk.el"
# shellcheck disable=SC2086
HOME="$sandbox" "$emacs" -Q --batch $load_path -L "$here" \
  -l "$here/fdbk.el" -l "$here/fdbk-test.el" \
  --eval "(ert-run-tests-batch-and-exit \"${1:-^fdbk-test}\")" </dev/null
