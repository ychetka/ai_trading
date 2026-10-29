#!/bin/sh
# Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
# Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
# For commercial use, please contact the author.
#
# Run the repo linters (self-contained: uvx and npx fetch the tools on demand).
# Usage: tools/lint.sh
set -e
cd "$(dirname "$0")/.."
uvx ruff check .
uvx ruff format --check .
npx -y eslint@10.13.0 tools/
