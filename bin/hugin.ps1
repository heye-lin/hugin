param(
  [string]$Distro = "Ubuntu",
  [string]$Project = "/mnt/d/code/Hugin"
)

$wt = Get-Command wt.exe -ErrorAction SilentlyContinue
if (-not $wt) {
  Write-Error "Windows Terminal (wt.exe) not found. Run this inside WSL instead: cd $Project && ./bin/hugin start"
  exit 1
}

$master = "cd $Project && ./bin/hugin start"
$agents = "cd $Project && ./bin/hugin dashboard"

wt.exe -w 0 new-tab --title "Hugin Master" wsl.exe -d $Distro -- bash -lc $master
wt.exe -w 0 new-tab --title "Hugin Agents" wsl.exe -d $Distro -- bash -lc $agents
