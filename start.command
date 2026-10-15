#!/bin/zsh
cd -- "${0:A:h}"
reader_python="${PAGE_BETWEEN_PYTHON:-.venv/bin/python}"
if [[ ! -x "$reader_python" ]]; then reader_python=python3; fi
if (( $# == 0 )) && curl --silent --fail --max-time 2 http://127.0.0.1:8778/api/library-version >/dev/null; then
  print '页间已在运行：http://127.0.0.1:8778/'
  exit 0
fi
exec "$reader_python" server.py "$@"
