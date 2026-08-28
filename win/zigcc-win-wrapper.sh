#!/bin/bash
# PATH 劫持 wrapper：转发给真实 zig，并在 `cc` 子命令后强制注入 POSIX shim include。
REAL_ZIG=/tmp/zig-macos-x86_64-0.13.0/zig
SHIM=/tmp/ev-win-hack/win32_posix_shim.h
args=("$@")
inject=()
for i in "${!args[@]}"; do
  if [ "${args[$i]}" = "cc" ]; then
    inject=("${args[@]:0:$((i+1))}" "-include" "$SHIM" "${args[@]:$((i+1))}")
    break
  fi
done
[ ${#inject[@]} -eq 0 ] && inject=("$@")
exec "$REAL_ZIG" "${inject[@]}"
