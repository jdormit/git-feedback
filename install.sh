#!/bin/sh
# Usage: ./install.sh [--uninstall]
# Builds dist/fdbk and symlinks it and the man pages into $PREFIX (default: ~/.local).
set -eu

usage() {
  echo "Usage: $0 [--uninstall]" >&2
  exit 2
}

case $# in
  0) mode=install ;;
  1) [ "$1" = --uninstall ] || usage; mode=uninstall ;;
  *) usage ;;
esac

repo=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
prefix=${PREFIX:-$HOME/.local}
bin=$prefix/bin
man1=$prefix/share/man/man1
tab=$(printf '\t')

links() {
  printf '%s\t%s\n' "$repo/dist/fdbk" "$bin/fdbk"
  printf '%s\t%s\n' "$repo/dist/fdbk" "$bin/git-feedback"
  for page in "$repo"/man/man1/*.1; do
    printf '%s\t%s\n' "$page" "$man1/$(basename "$page")"
  done
}

if [ "$mode" = uninstall ]; then
  links | while IFS=$tab read -r target link; do
    if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then
      rm "$link"
      echo "removed $link"
    elif [ -e "$link" ] || [ -L "$link" ]; then
      echo "skipped $link: not a link into $repo" >&2
    fi
  done
  exit 0
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is required to build fdbk: https://bun.sh" >&2
  exit 1
fi
command -v gh >/dev/null 2>&1 || echo "warning: gh not found; GitHub sync needs it" >&2

links | while IFS=$tab read -r target link; do
  if [ -L "$link" ] && [ "$(readlink "$link")" != "$target" ]; then
    echo "error: $link already links to $(readlink "$link"); remove it and rerun" >&2
    exit 1
  elif [ -e "$link" ] && [ ! -L "$link" ]; then
    echo "error: $link exists and isn't a symlink; move it and rerun" >&2
    exit 1
  fi
done

(cd "$repo" && bun install && bun run compile)

mkdir -p "$bin" "$man1"
links | while IFS=$tab read -r target link; do
  ln -sfn "$target" "$link"
  echo "linked $link"
done

case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "warning: $bin is not on your PATH" >&2 ;;
esac
