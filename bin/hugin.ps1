$Root = Split-Path -Parent $PSScriptRoot
& node "$Root\bin\hugin-cli.mjs" @args
exit $LASTEXITCODE
